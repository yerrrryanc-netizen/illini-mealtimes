// Downloads CUMTD's public bus schedule (GTFS, no key needed) and saves the part the app needs as buses.json
// (public/ by default): the stops around campus, and the next seven days of trips through them, grouped
// into patterns so it stays small. Run with `npm run buses`; the published site's job runs it every morning
// as `node scripts/fetch-buses.mjs site`.

import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const FEED = "https://mtd.dev/gtfs.zip";
const OUT_DIR = resolve(process.argv[2] ?? new URL("../public/", import.meta.url).pathname);
const DAYS_AHEAD = 7;
/** Campus, Campustown, and the dining halls south and east of them; stops outside are left out. */
const AREA = { south: 40.088, north: 40.122, west: -88.245, east: -88.212 };
const WEEKDAY_COLUMNS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DAY_KEYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Rows of a GTFS text file as objects. Fields may be quoted and contain commas. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) rows.push([...row, field]);
  const [header, ...body] = rows;
  const names = header.map((h) => h.replace(/^﻿/, "").trim());
  return body.map((values) => Object.fromEntries(names.map((name, i) => [name, values[i] ?? ""])));
}

/** "13:05:00" (GTFS times can pass 24:00 for after-midnight trips) as minutes after midnight. */
function minutesOf(time) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

/** Meters between two [lat, lng] points; flat-earth math is plenty accurate across campus. */
function meters(a, b) {
  const dy = (a[0] - b[0]) * 111_320;
  const dx = (a[1] - b[1]) * 111_320 * Math.cos((a[0] * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

/** How far a point is from the segment a-b, in meters. */
function metersFromSegment(p, a, b) {
  const scale = Math.cos((a[0] * Math.PI) / 180);
  const [px, py, ax, ay, bx, by] = [p[1] * scale, p[0], a[1] * scale, a[0], b[1] * scale, b[0]];
  const length2 = (bx - ax) ** 2 + (by - ay) ** 2;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / length2));
  return meters(p, [ay + t * (by - ay), (ax + t * (bx - ax)) / scale]);
}

/** A stop farther than this from every point of its bus's road path means the two don't match. */
const STOP_MATCH_METERS = 80;
/** Points closer than this to the line between their neighbors are dropped; the path still follows the road. */
const SIMPLIFY_METERS = 2;

/**
 * Where along a bus's road path (GTFS shape) each of its stops is, going in order: for each stop, the nearest
 * point after the previous stop's, stopping the search once the path has clearly moved on (it can loop back
 * past the same stop later). Null if a stop is too far from the path.
 */
function stopPositions(path, stopPoints) {
  const positions = [];
  let from = 0;
  for (const stop of stopPoints) {
    let best = -1;
    let bestMeters = Infinity;
    for (let i = from; i < path.length; i++) {
      const d = meters(path[i], stop);
      if (d < bestMeters) {
        best = i;
        bestMeters = d;
      } else if (bestMeters < STOP_MATCH_METERS && d > bestMeters + 400) break;
    }
    if (bestMeters > STOP_MATCH_METERS) return null;
    positions.push(best);
    from = best;
  }
  return positions;
}

/** Fewer points along the same road (Douglas-Peucker), always keeping the points in `keep`. */
function simplify(path, keep) {
  const kept = new Set([0, path.length - 1, ...keep]);
  const split = (first, last) => {
    let worst = -1;
    let worstMeters = SIMPLIFY_METERS;
    for (let i = first + 1; i < last; i++) {
      const d = metersFromSegment(path[i], path[first], path[last]);
      if (d > worstMeters) {
        worst = i;
        worstMeters = d;
      }
    }
    if (worst < 0) return;
    kept.add(worst);
    split(first, worst);
    split(worst, last);
  };
  const anchors = [...kept].sort((a, b) => a - b);
  for (let k = 1; k < anchors.length; k++) split(anchors[k - 1], anchors[k]);
  return [...kept].sort((a, b) => a - b);
}

/** The next DAYS_AHEAD dates in Champaign-Urbana, as YYYYMMDD with their weekday index. */
function localDates() {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" });
  return Array.from({ length: DAYS_AHEAD }, (_, i) => {
    const iso = format.format(new Date(Date.now() + i * 86_400_000));
    const [y, m, d] = iso.split("-").map(Number);
    return { yyyymmdd: iso.replaceAll("-", ""), weekday: new Date(y, m - 1, d).getDay() };
  });
}

const work = await mkdtemp(join(tmpdir(), "gtfs-"));
try {
  const response = await fetch(FEED);
  if (!response.ok) throw new Error(`GTFS download failed: HTTP ${response.status}`);
  const zip = join(work, "gtfs.zip");
  await writeFile(zip, Buffer.from(await response.arrayBuffer()));
  const read = (name) => parseCsv(execFileSync("unzip", ["-p", zip, name], { maxBuffer: 256 * 1024 * 1024 }).toString("utf8"));

  const inArea = (s) => {
    const lat = Number(s.stop_lat);
    const lng = Number(s.stop_lon);
    return lat >= AREA.south && lat <= AREA.north && lng >= AREA.west && lng <= AREA.east;
  };
  const stops = Object.fromEntries(
    read("stops.txt")
      .filter((s) => (s.location_type === "0" || s.location_type === "") && inArea(s))
      .map((s) => [s.stop_id, [Number(Number(s.stop_lat).toFixed(5)), Number(Number(s.stop_lon).toFixed(5)), s.stop_name]]),
  );
  const routes = Object.fromEntries(
    read("routes.txt").map((r) => [r.route_id, [r.route_short_name, r.route_long_name, r.route_color || "13294b", r.route_text_color || "ffffff"]]),
  );
  const trips = new Map(read("trips.txt").map((t) => [t.trip_id, t]));
  // Each bus's road path, as [lat, lng] points in order.
  const shapes = new Map();
  for (const point of read("shapes.txt")) {
    if (!shapes.has(point.shape_id)) shapes.set(point.shape_id, []);
    shapes.get(point.shape_id).push([Number(point.shape_pt_sequence), Number(point.shape_pt_lat), Number(point.shape_pt_lon)]);
  }
  for (const [id, points] of shapes) shapes.set(id, points.sort((a, b) => a[0] - b[0]).map(([, lat, lng]) => [lat, lng]));

  // Which services run on each of the next seven dates: the weekly calendar, then that date's exceptions.
  const calendar = read("calendar.txt");
  const exceptions = new Map();
  for (const e of read("calendar_dates.txt")) {
    if (!exceptions.has(e.date)) exceptions.set(e.date, []);
    exceptions.get(e.date).push(e);
  }
  const servicesByDay = {};
  for (const { yyyymmdd, weekday } of localDates()) {
    const running = new Set(
      calendar.filter((c) => c.start_date <= yyyymmdd && yyyymmdd <= c.end_date && c[WEEKDAY_COLUMNS[weekday]] === "1").map((c) => c.service_id),
    );
    for (const e of exceptions.get(yyyymmdd) ?? []) {
      if (e.exception_type === "1") running.add(e.service_id);
      else running.delete(e.service_id);
    }
    servicesByDay[DAY_KEYS[weekday]] = running;
  }

  // Each trip's stops in the area, in order.
  const stopTimes = new Map();
  for (const st of read("stop_times.txt")) {
    if (!(st.stop_id in stops)) continue;
    if (!stopTimes.has(st.trip_id)) stopTimes.set(st.trip_id, []);
    stopTimes.get(st.trip_id).push(st);
  }

  // Trips that make the same stops with the same gaps between them share a pattern; only start times differ.
  const patterns = new Map();
  for (const [tripId, rows] of stopTimes) {
    const trip = trips.get(tripId);
    if (!trip || rows.length < 2) continue;
    const days = DAY_KEYS.filter((day) => servicesByDay[day]?.has(trip.service_id));
    if (days.length === 0) continue;
    rows.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
    const start = minutesOf(rows[0].departure_time);
    const offsets = rows.map((r) => minutesOf(r.departure_time) - start);
    const stopIds = rows.map((r) => r.stop_id);
    const key = JSON.stringify([trip.route_id, trip.trip_headsign, stopIds, offsets]);
    if (!patterns.has(key)) patterns.set(key, { r: trip.route_id, h: trip.trip_headsign, s: stopIds, o: offsets, t: {}, shapeId: trip.shape_id });
    const pattern = patterns.get(key);
    for (const day of days) (pattern.t[day] ??= []).push(start);
  }
  for (const pattern of patterns.values()) for (const starts of Object.values(pattern.t)) starts.sort((a, b) => a - b);

  // The road path between each pattern's first and last stop on campus, shared by patterns that drive the
  // same streets: "g" names the path, and "x" says where along it each stop is.
  const paths = {};
  const pathKeys = new Map();
  let unmatched = 0;
  for (const pattern of patterns.values()) {
    const shape = shapes.get(pattern.shapeId);
    delete pattern.shapeId;
    const positions = shape && stopPositions(shape, pattern.s.map((id) => stops[id]));
    if (!positions) {
      unmatched++;
      continue; // the app draws this one stop to stop
    }
    const piece = shape.slice(positions[0], positions.at(-1) + 1);
    const keep = simplify(piece, positions.map((p) => p - positions[0]));
    const points = keep.map((i) => piece[i].map((n) => Number(n.toFixed(5))));
    const text = JSON.stringify(points);
    if (!pathKeys.has(text)) {
      pathKeys.set(text, String(pathKeys.size));
      paths[pathKeys.get(text)] = points.flat();
    }
    pattern.g = pathKeys.get(text);
    pattern.x = positions.map((p) => keep.indexOf(p - positions[0]));
  }

  const usedRoutes = new Set([...patterns.values()].map((p) => p.r));
  const file = {
    fetchedAt: new Date().toISOString(),
    stops,
    routes: Object.fromEntries(Object.entries(routes).filter(([id]) => usedRoutes.has(id))),
    patterns: [...patterns.values()],
    paths,
  };
  await writeFile(join(OUT_DIR, "buses.json"), JSON.stringify(file));
  const tripCount = file.patterns.reduce((sum, p) => sum + Object.values(p.t).reduce((n, s) => n + s.length, 0), 0);
  console.log(`buses.json: ${Object.keys(stops).length} stops, ${usedRoutes.size} routes, ${file.patterns.length} patterns, ${tripCount} trips this week`);
  console.log(`road paths: ${Object.keys(paths).length}, ${unmatched} patterns drawn stop to stop because their stops didn't match a path`);
} finally {
  await rm(work, { recursive: true, force: true });
}
