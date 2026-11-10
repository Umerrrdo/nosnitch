import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateDatabase } from "../dist/db.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const db = JSON.parse(readFileSync(new URL("../db/index.json", import.meta.url), "utf8"));

test("every yaml entry is valid and db/index.json is up to date", () => {
  execFileSync(process.execPath, ["scripts/build-db.mjs", "--check"], { cwd: root, stdio: "pipe" });
});

test("bundled database passes the schema", () => {
  assert.deepEqual(validateDatabase(db), []);
});

test("every entry has at least one https source", () => {
  for (const app of db.apps) {
    assert.ok(app.sources.length >= 1, app.slug);
    for (const url of app.sources) assert.match(url, /^https:\/\//, app.slug);
  }
});

test("schema rejects an entry without sources", () => {
  const bad = { ...db.apps[0], sources: [] };
  assert.notDeepEqual(validateDatabase({ schema_version: 1, apps: [bad] }), []);
});

test("schema rejects an unknown disable type", () => {
  const bad = { ...db.apps[0], disable: [{ type: "magic", name: "X" }] };
  assert.notDeepEqual(validateDatabase({ schema_version: 1, apps: [bad] }), []);
});
