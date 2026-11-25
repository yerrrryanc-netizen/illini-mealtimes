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
    if (!patterns.has(key)) patterns.set(key, { r: trip.route_id, h: trip.trip_headsign, s: stopIds, o: offsets, t: {} });
    const pattern = patterns.get(key);
    for (const day of days) (pattern.t[day] ??= []).push(start);
  }
  for (const pattern of patterns.values()) for (const starts of Object.values(pattern.t)) starts.sort((a, b) => a - b);

  const usedRoutes = new Set([...patterns.values()].map((p) => p.r));
  const file = {
    fetchedAt: new Date().toISOString(),
    stops,
    routes: Object.fromEntries(Object.entries(routes).filter(([id]) => usedRoutes.has(id))),
    patterns: [...patterns.values()],
  };
  await writeFile(join(OUT_DIR, "buses.json"), JSON.stringify(file));
  const tripCount = file.patterns.reduce((sum, p) => sum + Object.values(p.t).reduce((n, s) => n + s.length, 0), 0);
  console.log(`buses.json: ${Object.keys(stops).length} stops, ${usedRoutes.size} routes, ${file.patterns.length} patterns, ${tripCount} trips this week`);
} finally {
  await rm(work, { recursive: true, force: true });
}
