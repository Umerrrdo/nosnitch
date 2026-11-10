import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { cacheDbPath, validateDatabase } from "./db.js";
import { NosnitchError } from "./errors.js";
import type { Database } from "./types.js";

export const UPDATE_URL = "https://raw.githubusercontent.com/Umerrrdo/nosnitch/main/db/index.json";

/**
 * Downloads the latest database. This is the only code path in nosnitch that
 * touches the network, and it only runs when the user passes --update.
 */
export async function updateDatabase(url: string = process.env.NOSNITCH_UPDATE_URL ?? UPDATE_URL): Promise<number> {
  const keep = "nosnitch keeps using the database it already has, so you can run the same command without --update.";
  let db: Database;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new NosnitchError(`Could not download the database: the server answered HTTP ${res.status} for ${url}`, keep);
    db = (await res.json()) as Database;
  } catch (err) {
    if (err instanceof NosnitchError) throw err;
    throw new NosnitchError(`Could not download the database from ${url}: ${(err as Error).message}`, `Check your internet connection. ${keep}`);
  }
  const problems = validateDatabase(db);
  if (problems.length > 0) {
    throw new NosnitchError(`The downloaded database is not valid, so it was not saved:\n${problems.slice(0, 5).join("\n")}`, keep);
  }
  const target = cacheDbPath();
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(db));
  return db.apps.length;
}
