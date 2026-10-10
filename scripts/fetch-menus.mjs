// Downloads a week of University Housing dining menus as <date>.json files (public/menus/ by default).
// The menu feed doesn't allow browsers on other sites to read it, so the app reads these
// saved files instead. Run with `npm run menus`; the published site's job runs it every morning
// as `node scripts/fetch-menus.mjs site/menus`.

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const FEED = "https://web.housing.illinois.edu/DiningMenus/api/DiningMenu/GetOption/";
const OUT_DIR = resolve(process.argv[2] ?? new URL("../public/menus/", import.meta.url).pathname);
const DAYS_AHEAD = 7;

/** University Housing's DiningOptionID for each location (from the selects on their menu page). */
const LOCATIONS = {
  1: "Ikenberry Dining Center",
  2: "PAR Dining Hall",
  3: "ISR Dining Center",
  5: "Lincoln/Allen Dining Hall",
  6: "Corner Cafe",
  7: "57 North",
  9: "Caffeinator",
  14: "Urbana South Market",
  18: "TerraByte",
  30: "InfiniTEA",
};

/** Dates in Champaign-Urbana's time zone, so the "today" file matches the local day. */
function localDates(count) {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" });
  return Array.from({ length: count }, (_, i) => format.format(new Date(Date.now() + i * 86_400_000)));
}

async function fetchLocation(id, date) {
  const response = await fetch(FEED, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ DiningOptionID: String(id), mealDate: date }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return JSON.parse(await response.text());
}

/** Group feed rows into meal -> station -> items, keeping only what the app shows. */
function summarize(rows) {
  const meals = {};
  for (const row of rows.sort((a, b) => a.MealOrder - b.MealOrder || a.CourseSort - b.CourseSort)) {
    const meal = (meals[row.Meal] ??= {});
    const items = (meal[row.ServingUnit] ??= []);
    if (items.some((item) => item.name === row.FormalName)) continue;
    items.push({ name: row.FormalName, traits: (row.Traits ?? "").split(",").filter(Boolean) });
  }
  return Object.fromEntries(
    Object.entries(meals).map(([meal, stations]) => [
      meal,
      Object.entries(stations).map(([station, items]) => ({ station, items })),
    ]),
  );
}

await mkdir(OUT_DIR, { recursive: true });
let failures = 0;
for (const date of localDates(DAYS_AHEAD)) {
  const locations = {};
  for (const id of Object.keys(LOCATIONS)) {
    try {
      locations[id] = summarize(await fetchLocation(id, date));
    } catch (error) {
      failures++;
      console.warn(`${date} ${LOCATIONS[id]}: ${error.message}`);
    }
  }
  const file = { date, fetchedAt: new Date().toISOString(), locations };
  await writeFile(join(OUT_DIR, `${date}.json`), JSON.stringify(file));
  const itemCount = Object.values(locations)
    .flatMap((meals) => Object.values(meals).flat())
    .reduce((sum, station) => sum + station.items.length, 0);
  console.log(`${date}: ${Object.keys(locations).length} locations, ${itemCount} items`);
}
if (failures) process.exitCode = 1;
