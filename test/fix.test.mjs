import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "dist", "cli.js");
const env = { ...process.env, NOSNITCH_CACHE_DIR: mkdtempSync(join(tmpdir(), "nosnitch-cache-")) };
const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env });

function workdir(fixture) {
  const dir = mkdtempSync(join(tmpdir(), "nosnitch-fix-"));
  copyFileSync(join(root, "test", "fixtures", fixture), join(dir, "compose.yml"));
  if (fixture === "example-compose.yml") copyFileSync(join(root, "test", "fixtures", "langfuse.env"), join(dir, "langfuse.env"));
  return dir;
}

test("--fix writes only the env additions and leaves the original untouched", () => {
  const dir = workdir("example-compose.yml");
  const compose = join(dir, "compose.yml");
  const before = readFileSync(compose, "utf8");

  const res = run(["scan", compose, "--fix"]);
  assert.equal(res.status, 1);
  assert.equal(readFileSync(compose, "utf8"), before);

  const override = parse(readFileSync(join(dir, "compose.nosnitch.override.yml"), "utf8"));
  assert.deepEqual(override, {
    services: {
      n8n: { environment: { N8N_DIAGNOSTICS_ENABLED: "false" } },
      hasura: { environment: { HASURA_GRAPHQL_ENABLE_TELEMETRY: "false" } },
      "immich-machine-learning": { environment: { ORT_DISABLE_TELEMETRY: "1" } },
    },
  });
});

test("scanning the original plus the override exits 0", () => {
  const dir = workdir("example-compose.yml");
  const compose = join(dir, "compose.yml");
  run(["scan", compose, "--fix"]);
  const res = run(["scan", compose, join(dir, "compose.nosnitch.override.yml")]);
  assert.equal(res.status, 0, res.stdout);
});

test("--fix writes nothing when there is nothing to fix", () => {
  const dir = workdir("clean-compose.yml");
  const res = run(["scan", join(dir, "compose.yml"), "--fix"]);
  assert.equal(res.status, 0);
  assert.equal(existsSync(join(dir, "compose.nosnitch.override.yml")), false);
  assert.match(res.stdout, /No override file written/);
});

test("unverified entries are written with a warning comment", () => {
  const dir = workdir("unverified-compose.yml");
  run(["scan", join(dir, "compose.yml"), "--fix"]);
  const text = readFileSync(join(dir, "compose.nosnitch.override.yml"), "utf8");
  assert.match(text, /# Firezone: unverified database entry/);
  assert.equal(parse(text).services.firezone.environment.TELEMETRY_ENABLED, "false");
});
