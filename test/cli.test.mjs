import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "dist", "cli.js");
const guard = pathToFileURL(join(root, "scripts", "no-network.mjs")).href;
const fixture = (name) => join(root, "test", "fixtures", name);
// An empty cache dir so a database downloaded on this machine cannot change the results.
const env = { ...process.env, NOSNITCH_CACHE_DIR: mkdtempSync(join(tmpdir(), "nosnitch-cache-")) };

export function run(args, { network = false } = {}) {
  const nodeArgs = network ? [cli, ...args] : ["--import", guard, cli, ...args];
  const res = spawnSync(process.execPath, nodeArgs, { cwd: root, env, encoding: "utf8" });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

test("exit 1 when telemetry is on and not disabled", () => {
  const res = run(["scan", fixture("example-compose.yml")]);
  assert.equal(res.code, 1);
  assert.match(res.stdout, /N8N_DIAGNOSTICS_ENABLED=false/);
  assert.match(res.stdout, /telemetry\.hasura\.io/);
});

test("exit 0 when everything known is disabled", () => {
  assert.equal(run(["scan", fixture("clean-compose.yml")]).code, 0);
});

test("exit 0 when only unverified or unknown entries are found", () => {
  assert.equal(run(["scan", fixture("unverified-compose.yml")]).code, 0);
});

test("exit 2 on a missing file, a missing argument and an unknown command", () => {
  assert.equal(run(["scan", "does-not-exist.yml"]).code, 2);
  assert.equal(run(["scan"]).code, 2);
  assert.equal(run(["frobnicate"]).code, 2);
});

test("unknown images are listed as not in database with a link to CONTRIBUTING.md", () => {
  const res = run(["scan", fixture("example-compose.yml")]);
  assert.match(res.stdout, /postgres:16-alpine/);
  assert.match(res.stdout, /not in database/i);
  assert.match(res.stdout, /CONTRIBUTING\.md/);
});

test("scan --json", () => {
  const res = run(["scan", fixture("example-compose.yml"), "--json"]);
  assert.equal(res.code, 1);
  const out = JSON.parse(res.stdout);
  assert.equal(out.exit_code, 1);
  assert.equal(out.services.find((s) => s.service === "n8n").status, "on");
  assert.equal(out.services.find((s) => s.service === "grafana").status, "disabled");
});

test("check and check --json", () => {
  const text = run(["check", "docker.io/n8nio/n8n:latest"]);
  assert.equal(text.code, 0);
  assert.match(text.stdout, /N8N_DIAGNOSTICS_ENABLED=false/);
  assert.match(text.stdout, /https:\/\/docs\.n8n\.io/);
  const json = JSON.parse(run(["check", "n8nio/n8n", "--json"]).stdout);
  assert.equal(json.slug, "n8n");
  const unknown = run(["check", "nginx:latest"]);
  assert.equal(unknown.code, 0);
  assert.match(unknown.stdout, /not in database/);
});

test("list shows every app", () => {
  const res = run(["list"]);
  assert.equal(res.code, 0);
  for (const slug of ["n8n", "documenso", "langfuse", "immich-machine-learning", "signoz"]) assert.match(res.stdout, new RegExp(slug));
});

test("no network calls in default mode", () => {
  // Every run() above already goes through the guard. This checks the marker explicitly.
  for (const args of [["scan", fixture("example-compose.yml")], ["check", "n8nio/n8n"], ["list"], ["--help"]]) {
    const res = run(args);
    assert.doesNotMatch(res.stderr + res.stdout, /NOSNITCH_NETWORK_ATTEMPT/, args.join(" "));
  }
});

test("the network guard really catches network use", () => {
  const dir = mkdtempSync(join(tmpdir(), "nosnitch-guard-"));
  const script = join(dir, "probe.mjs");
  writeFileSync(script, 'import net from "node:net";\ntry { net.connect(80, "127.0.0.1"); } catch {}\ntry { await fetch("http://127.0.0.1"); } catch {}\n');
  const res = spawnSync(process.execPath, ["--import", guard, script], { encoding: "utf8" });
  assert.match(res.stderr, /NOSNITCH_NETWORK_ATTEMPT: net\.connect/);
  assert.match(res.stderr, /NOSNITCH_NETWORK_ATTEMPT: fetch/);
});

test("--update is the only path that reaches for the network", () => {
  const res = run(["list", "--update"]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /NOSNITCH_NETWORK_ATTEMPT: fetch/);
});
