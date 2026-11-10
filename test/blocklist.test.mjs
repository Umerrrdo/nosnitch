import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "dist", "cli.js");
const example = join(root, "test", "fixtures", "example-compose.yml");
const env = { ...process.env, PHONEHOME_CACHE_DIR: mkdtempSync(join(tmpdir(), "phonehome-cache-")) };
const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env });
const rules = (out) => out.split(/\r?\n/).filter((l) => l !== "" && !l.startsWith("#") && !l.startsWith("!"));

const expected = ["eu.posthog.com", "mobile.events.data.microsoft.com", "stats.grafana.org", "telemetry.hasura.io"];

test("hosts format is the default", () => {
  const res = run(["blocklist", example]);
  assert.equal(res.status, 0);
  assert.deepEqual(rules(res.stdout), expected.map((h) => `0.0.0.0 ${h}`));
  assert.match(res.stdout, /# Hasura GraphQL Engine/);
});

test("pihole format is a plain domain list", () => {
  assert.deepEqual(rules(run(["blocklist", example, "--format", "pihole"]).stdout), expected);
});

test("adguard format uses adblock rules and ! comments", () => {
  const res = run(["blocklist", example, "--format=adguard"]);
  assert.deepEqual(rules(res.stdout), expected.map((h) => `||${h}^`));
  assert.doesNotMatch(res.stdout, /^#/m);
});

test("unknown format is a usage error", () => {
  assert.equal(run(["blocklist", example, "--format", "xml"]).status, 2);
});

test("no destinations gives a comment and no rules", () => {
  const res = run(["blocklist", join(root, "test", "fixtures", "unverified-compose.yml")]);
  assert.equal(res.status, 0);
  assert.deepEqual(rules(res.stdout), []);
});
