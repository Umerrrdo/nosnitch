import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import type { AppEntry, Database } from "./types.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export const bundledDbPath = join(packageRoot, "db", "index.json");
export const schemaPath = join(packageRoot, "db", "schema.json");

export function cacheDbPath(): string {
  const base = process.env.NOSNITCH_CACHE_DIR ?? join(homedir(), ".cache", "nosnitch");
  return join(base, "index.json");
}

/** Returns a list of problems. Empty means the database is valid. */
export function validateDatabase(db: unknown): string[] {
  if (typeof db !== "object" || db === null || !Array.isArray((db as Database).apps)) {
    return ["database must be an object with an apps list"];
  }
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const validate = new Ajv({ allErrors: true }).compile(schema);
  const problems: string[] = [];
  for (const [i, entry] of (db as Database).apps.entries()) {
    if (!validate(entry)) {
      const label = (entry as AppEntry | null)?.slug ?? `entry ${i}`;
      for (const e of validate.errors ?? []) problems.push(`${label}: ${e.instancePath || "/"} ${e.message}`);
    }
  }
  return problems;
}

/**
 * Loads the database from disk. A copy downloaded with --update is used when it
 * exists and is valid, otherwise the copy bundled with the package.
 */
export function loadDatabase(): { db: Database; source: "bundled" | "updated" } {
  const cached = cacheDbPath();
  if (existsSync(cached)) {
    try {
      const db = JSON.parse(readFileSync(cached, "utf8")) as Database;
      if (validateDatabase(db).length === 0) return { db, source: "updated" };
    } catch {
      // fall through to the bundled copy
    }
  }
  return { db: JSON.parse(readFileSync(bundledDbPath, "utf8")) as Database, source: "bundled" };
}
