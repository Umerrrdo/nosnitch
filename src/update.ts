import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { cacheDbPath, validateDatabase } from "./db.js";
import type { Database } from "./types.js";

export const UPDATE_URL = "https://raw.githubusercontent.com/Umerrrdo/phonehome/main/db/index.json";

/**
 * Downloads the latest database. This is the only code path in phonehome that
 * touches the network, and it only runs when the user passes --update.
 */
export async function updateDatabase(url: string = process.env.PHONEHOME_UPDATE_URL ?? UPDATE_URL): Promise<number> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not download the database: HTTP ${res.status} from ${url}`);
  const db = (await res.json()) as Database;
  const problems = validateDatabase(db);
  if (problems.length > 0) throw new Error(`downloaded database is not valid, keeping the current one:\n${problems.slice(0, 5).join("\n")}`);
  const target = cacheDbPath();
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(db));
  return db.apps.length;
}
