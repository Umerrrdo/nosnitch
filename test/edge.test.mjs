// Edge cases a first-time user can hit. Each one runs the real CLI in a temp folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { interpolate } from "../dist/compose.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "dist", "cli.js");
const env = { ...process.env, PHONEHOME_CACHE_DIR: mkdtempSync(join(tmpdir(), "phonehome-cache-")) };
delete env.N8N_VERSION;
delete env.MY_IMAGE;

/** Creates a temp project. Keys are relative paths, values are file contents (string or Buffer). */
function project(files, prefix = "phonehome-edge-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}
function run(args, cwd = root) {
  const res = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, all: res.stdout + res.stderr };
}
function scanJson(args, cwd) {
  const res = run([...args, "--json"], cwd);
  const report = JSON.parse(res.stdout);
  return { ...res, report, by: Object.fromEntries(report.services.map((s) => [s.service, s])) };
}
const noStack = (res) => assert.doesNotMatch(res.all, /\n\s+at .+:\d+:\d+\)?/, "no stack trace expected");

const N8N_ON = "services:\n  n8n:\n    image: n8nio/n8n:1.70.2\n";
const N8N_OFF = `${N8N_ON}    environment:\n      - N8N_DIAGNOSTICS_ENABLED=false\n`;

// ---- file encodings ----

test("Windows line endings in the compose file and the env_file", () => {
  const dir = project({
    "compose.yml": "services:\r\n  n8n:\r\n    image: n8nio/n8n\r\n    env_file: app.env\r\n  hasura:\r\n    image: hasura/graphql-engine\r\n    environment:\r\n      - HASURA_GRAPHQL_ENABLE_TELEMETRY=false\r\n",
    "app.env": "OTHER=1\r\nN8N_DIAGNOSTICS_ENABLED=false\r\n",
  });
  const { by, code } = scanJson(["scan", join(dir, "compose.yml")]);
  assert.equal(by.n8n.status, "disabled");
  assert.equal(by.hasura.status, "disabled");
  assert.equal(code, 0);
});

test("UTF-8 BOM in the compose file and the env_file", () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const dir = project({
    "compose.yml": Buffer.concat([bom, Buffer.from("services:\n  n8n:\n    image: n8nio/n8n\n    env_file: app.env\n")]),
    "app.env": Buffer.concat([bom, Buffer.from("N8N_DIAGNOSTICS_ENABLED=false\n")]),
  });
  const { by } = scanJson(["scan", join(dir, "compose.yml")]);
  assert.equal(by.n8n.status, "disabled");
});

// ---- files that are not usable ----

test("empty file", () => {
  for (const content of ["", "   \n\n", "\uFEFF"]) {
    const dir = project({ "compose.yml": content });
    const res = run(["scan", join(dir, "compose.yml")]);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /is empty/);
    assert.match(res.stderr, /services: section/);
    noStack(res);
  }
});

test("invalid YAML says where the problem is", () => {
  const dir = project({ "compose.yml": "services:\n  n8n:\n    image: n8nio/n8n\n   environment: [unclosed\n" });
  const res = run(["scan", join(dir, "compose.yml")]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /is not valid YAML/);
  assert.match(res.stderr, /line \d+/);
  assert.match(res.stderr, /docker compose -f .* config/);
  noStack(res);
});

test("a file with no services", () => {
  for (const content of ["version: '3'\n", "services:\n", "services: {}\n", "volumes:\n  data: {}\n"]) {
    const dir = project({ "compose.yml": content });
    const res = run(["scan", join(dir, "compose.yml")]);
    assert.equal(res.code, 2, content);
    assert.match(res.stderr, /No services found/);
    assert.match(res.stderr, /Is this a Docker Compose file/);
    noStack(res);
  }
});

test("a YAML file that is not a compose file at all", () => {
  for (const content of ["- just\n- a list\n", "hello\n", "42\n"]) {
    const dir = project({ "compose.yml": content });
    const res = run(["scan", join(dir, "compose.yml")]);
    assert.equal(res.code, 2, content);
    assert.match(res.stderr, /does not look like a Compose file/);
    noStack(res);
  }
});

test("missing file and folder without a compose file", () => {
  const missing = run(["scan", "nope/docker-compose.yml"]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /File not found: nope/);
  assert.match(missing.stderr, /Check the path/);
  const dir = project({ "README.txt": "x" });
  const folder = run(["scan", dir]);
  assert.equal(folder.code, 2);
  assert.match(folder.stderr, /is a folder and has no compose file/);
  noStack(folder);
});

test("a service with an empty definition does not crash", () => {
  const dir = project({ "compose.yml": "services:\n  empty:\n  n8n:\n    image: n8nio/n8n\n" });
  const { by } = scanJson(["scan", join(dir, "compose.yml")]);
  assert.equal(by.empty.status, "no-image");
  assert.equal(by.n8n.status, "on");
});

// ---- file naming ----

test("every standard file name is found when no file is given", () => {
  for (const name of ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"]) {
    const dir = project({ [name]: N8N_ON });
    const res = run(["scan"], dir);
    assert.equal(res.code, 1, name);
    assert.match(res.stdout, /N8N_DIAGNOSTICS_ENABLED=false/, name);
  }
});

test("compose.yaml wins over docker-compose.yml, like Docker Compose", () => {
  const dir = project({ "compose.yaml": N8N_OFF, "docker-compose.yml": N8N_ON });
  assert.equal(run(["scan"], dir).code, 0);
  assert.equal(run(["blocklist"], dir).code, 0);
});

test("a folder can be passed instead of a file", () => {
  const dir = project({ "stack/docker-compose.yml": N8N_ON });
  assert.equal(run(["scan", join(dir, "stack")]).code, 1);
});

test("no file given and none in the folder", () => {
  const dir = project({ "notes.txt": "x" });
  const res = run(["scan"], dir);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /No compose file given and none found/);
  assert.match(res.stderr, /phonehome scan docker-compose\.yml/);
  noStack(res);
});

// ---- include, extends, profiles ----

test("include is followed, in string and path form", () => {
  const dir = project({
    "compose.yml": "include:\n  - apps/n8n.yml\n  - path: apps/hasura.yml\n  - path:\n      - apps/grafana.yml\nservices:\n  db:\n    image: postgres:16\n",
    "apps/n8n.yml": "services:\n  n8n:\n    image: n8nio/n8n\n    env_file: n8n.env\n",
    "apps/n8n.env": "N8N_DIAGNOSTICS_ENABLED=false\n",
    "apps/hasura.yml": "services:\n  hasura:\n    image: hasura/graphql-engine\n",
    "apps/grafana.yml": "services:\n  grafana:\n    image: grafana/grafana\n",
  });
  const { by, report } = scanJson(["scan", join(dir, "compose.yml")]);
  assert.equal(by.n8n.status, "disabled", "env_file is resolved relative to the included file");
  assert.equal(by.hasura.status, "on");
  assert.equal(by.grafana.status, "on");
  assert.equal(by.db.status, "not-in-database");
  assert.deepEqual(report.warnings, []);
});

test("a missing include is reported, not fatal", () => {
  const dir = project({ "compose.yml": `include:\n  - gone.yml\n${N8N_ON}` });
  const { by, report } = scanJson(["scan", join(dir, "compose.yml")]);
  assert.equal(by.n8n.status, "on");
  assert.match(report.warnings[0], /gone\.yml, which was not found/);
});

test("an include loop ends", () => {
  const dir = project({ "a.yml": `include:\n  - b.yml\n${N8N_ON}`, "b.yml": "include:\n  - a.yml\nservices:\n  db:\n    image: postgres\n" });
  assert.equal(scanJson(["scan", join(dir, "a.yml")]).report.services.length, 2);
});

test("extends is followed in the same file and across files", () => {
  const dir = project({
    "compose.yml": [
      "services:",
      "  base:",
      "    image: n8nio/n8n",
      "    environment:",
      "      N8N_DIAGNOSTICS_ENABLED: 'false'",
      "  worker:",
      "    extends:",
      "      service: base",
      "    command: worker",
      "  loud:",
      "    extends: base",
      "    environment:",
      "      N8N_DIAGNOSTICS_ENABLED: 'true'",
      "  remote:",
      "    extends:",
      "      file: common/base.yml",
      "      service: hasura",
    ].join("\n"),
    "common/base.yml": "services:\n  hasura:\n    image: hasura/graphql-engine\n    env_file: hasura.env\n",
    "common/hasura.env": "HASURA_GRAPHQL_ENABLE_TELEMETRY=false\n",
  });
  const { by, report } = scanJson(["scan", join(dir, "compose.yml")]);
  assert.equal(by.worker.image, "n8nio/n8n");
  assert.equal(by.worker.status, "disabled");
  assert.equal(by.loud.status, "on", "the extending service can override the base");
  assert.equal(by.remote.status, "disabled");
  assert.deepEqual(report.warnings, []);
});

test("extends pointing at a missing file or a loop is reported once, not fatal", () => {
  const dir = project({
    "compose.yml":
      "services:\n  a:\n    extends:\n      file: gone.yml\n      service: x\n  b:\n    extends:\n      file: gone.yml\n      service: y\n  c:\n    image: n8nio/n8n\n    extends: d\n  d:\n    extends: c\n",
  });
  const { by, report } = scanJson(["scan", join(dir, "compose.yml")]);
  assert.equal(by.a.status, "no-image");
  assert.equal(by.c.status, "on");
  assert.equal(report.warnings.filter((w) => /gone\.yml not found/.test(w)).length, 1);
  assert.ok(report.warnings.some((w) => /forms a loop/.test(w)));
});

test("services behind profiles are scanned too", () => {
  const dir = project({ "compose.yml": `${N8N_ON}    profiles: [automation]\n  grafana:\n    image: grafana/grafana\n    profiles:\n      - monitoring\n` });
  const { by } = scanJson(["scan", join(dir, "compose.yml")]);
  assert.equal(by.n8n.status, "on");
  assert.equal(by.grafana.status, "on");
});

// ---- values with quotes and spaces ----

test("quoting styles that Compose treats as a plain value all count", () => {
  const variants = [
    '      - "N8N_DIAGNOSTICS_ENABLED=false"',
    "      - 'N8N_DIAGNOSTICS_ENABLED=false'",
    "      - N8N_DIAGNOSTICS_ENABLED=false",
    "      N8N_DIAGNOSTICS_ENABLED: false",
    '      N8N_DIAGNOSTICS_ENABLED: "false"',
    "      N8N_DIAGNOSTICS_ENABLED: 'false'",
    "      N8N_DIAGNOSTICS_ENABLED: False",
  ];
  for (const line of variants) {
    const dir = project({ "compose.yml": `${N8N_ON}    environment:\n${line}\n` });
    assert.equal(scanJson(["scan", join(dir, "compose.yml")]).by.n8n.status, "disabled", line);
  }
});

test("literal quotes or spaces inside the value do not count, and the reason is explained", () => {
  for (const line of ['      - N8N_DIAGNOSTICS_ENABLED="false"', "      - N8N_DIAGNOSTICS_ENABLED= false", "      N8N_DIAGNOSTICS_ENABLED: \"'false'\""]) {
    const dir = project({ "compose.yml": `${N8N_ON}    environment:\n${line}\n` });
    const res = run(["scan", join(dir, "compose.yml")]);
    assert.equal(res.code, 1, line);
    assert.match(res.stdout, /extra quote characters or spaces/, line);
    assert.match(res.stdout, /Write it as N8N_DIAGNOSTICS_ENABLED=false/, line);
  }
});

test("env_file values: quotes are stripped, spaces and comments handled", () => {
  for (const line of ['N8N_DIAGNOSTICS_ENABLED="false"', "N8N_DIAGNOSTICS_ENABLED='false'", "N8N_DIAGNOSTICS_ENABLED = false", "N8N_DIAGNOSTICS_ENABLED=false # off", "export N8N_DIAGNOSTICS_ENABLED=false"]) {
    const dir = project({ "compose.yml": `${N8N_ON}    env_file: [app.env]\n`, "app.env": `${line}\n` });
    assert.equal(scanJson(["scan", join(dir, "compose.yml")]).by.n8n.status, "disabled", line);
  }
});

test("other variables with spaces, quotes, equals signs and unicode do not confuse the parser", () => {
  const dir = project({
    "compose.yml": `${N8N_ON}    environment:\n      - GREETING=hello world = "quoted" and 'single'\n      - EMOJI=caf\u00e9 \u2603\n      - EMPTY=\n      - N8N_DIAGNOSTICS_ENABLED=false\n      - 'JSON={"a": "b c"}'\n`,
  });
  assert.equal(scanJson(["scan", join(dir, "compose.yml")]).by.n8n.status, "disabled");
});

test("a variable passed through from the host is explained", () => {
  const dir = project({ "compose.yml": `${N8N_ON}    environment:\n      - N8N_DIAGNOSTICS_ENABLED\n` });
  const res = run(["scan", join(dir, "compose.yml")]);
  assert.equal(res.code, 1);
  assert.match(res.stdout, /passed through from the host without a value/);
});

// ---- variables ----

test("nested defaults and every operator", () => {
  assert.equal(interpolate("${A:-${B:-4}}", {}), "4");
  assert.equal(interpolate("${A:-${B:-4}}", { B: "7" }), "7");
  assert.equal(interpolate("img:${A:-${B:-4}}-x", { A: "1" }), "img:1-x");
  assert.equal(interpolate("${A:+yes}${B+no}", { A: "1" }), "yes");
  assert.equal(interpolate("${A:?must be set}", { A: "ok" }), "ok");
  assert.equal(interpolate("${A:?must be set}", {}), "");
  assert.equal(interpolate("${A", {}), "${A");
  assert.equal(interpolate("cost $5 and $$HOME", { HOME: "x" }), "cost $5 and $HOME");
  const missing = new Set();
  assert.equal(interpolate("repo/${NAME}:${TAG:-1}", {}, { missing, keepMissing: true }), "repo/${NAME}:1");
  assert.deepEqual([...missing], ["NAME"]);
});

test("an unset variable in the tag still matches, in the name it is reported", () => {
  const dir = project({ "compose.yml": "services:\n  n8n:\n    image: docker.n8n.io/n8nio/n8n:${N8N_VERSION}\n  app:\n    image: ${MY_IMAGE}:latest\n" });
  const res = scanJson(["scan", join(dir, "compose.yml")]);
  assert.equal(res.by.n8n.status, "on");
  assert.equal(res.by.app.status, "unresolved-image");
  const text = run(["scan", join(dir, "compose.yml")]);
  assert.match(text.stdout, /uses a variable that is not set/);
  assert.match(text.stdout, /\.env file next to the compose file/);
});

test("variables come from the .env next to the compose file", () => {
  const dir = project({ ".env": "MY_IMAGE=n8nio/n8n\nDIAG=false\n", "compose.yml": "services:\n  app:\n    image: ${MY_IMAGE}:latest\n    environment:\n      N8N_DIAGNOSTICS_ENABLED: ${DIAG}\n" });
  assert.equal(scanJson(["scan", join(dir, "compose.yml")]).by.app.status, "disabled");
});

test("a file that reuses one anchor hundreds of times", () => {
  const services = Array.from({ length: 400 }, (_, i) => `  s${i}:\n    image: n8nio/n8n\n    environment:\n      <<: *common\n`).join("");
  const dir = project({ "compose.yml": `x-common: &common\n  N8N_DIAGNOSTICS_ENABLED: 'false'\nservices:\n${services}` });
  const res = scanJson(["scan", join(dir, "compose.yml")]);
  assert.equal(res.code, 0);
  assert.equal(res.report.services.length, 400);
});

// ---- paths ----

test("paths with spaces, for the compose file and the env_file", () => {
  const dir = project({ "my stack/docker compose.yml": `${N8N_ON}    env_file:\n      - ./env files/app one.env\n`, "my stack/env files/app one.env": "N8N_DIAGNOSTICS_ENABLED=false\n" }, "phonehome edge ");
  const file = join(dir, "my stack", "docker compose.yml");
  assert.equal(scanJson(["scan", file]).by.n8n.status, "disabled");

  const fixDir = project({ "my stack/docker compose.yml": N8N_ON }, "phonehome edge ");
  const res = run(["scan", join(fixDir, "my stack", "docker compose.yml"), "--fix"]);
  assert.equal(res.code, 1);
  assert.match(res.stdout, /docker compose -f ".*docker compose\.yml" -f ".*compose\.phonehome\.override\.yml" up -d/);
  assert.equal(run(["scan", join(fixDir, "my stack", "docker compose.yml"), join(fixDir, "my stack", "compose.phonehome.override.yml")]).code, 0);
});

test("relative paths and ./ prefixes", () => {
  const dir = project({ "sub/compose.yml": N8N_ON });
  assert.equal(run(["scan", "sub/compose.yml"], dir).code, 1);
  assert.equal(run(["scan", "./sub/compose.yml"], dir).code, 1);
  assert.equal(run(["scan", "../compose.yml"], join(dir, "sub")).code, 2);
});

test("backslash paths in env_file, include and extends", () => {
  const dir = project({
    "compose.yml": "include:\n  - apps\\hasura.yml\nservices:\n  n8n:\n    image: n8nio/n8n\n    env_file: conf\\app.env\n  g:\n    extends:\n      file: apps\\grafana.yml\n      service: grafana\n",
    "conf/app.env": "N8N_DIAGNOSTICS_ENABLED=false\n",
    "apps/hasura.yml": "services:\n  hasura:\n    image: hasura/graphql-engine\n",
    "apps/grafana.yml": "services:\n  grafana:\n    image: grafana/grafana\n",
  });
  const { by, report } = scanJson(["scan", join(dir, "compose.yml")]);
  assert.equal(by.n8n.status, "disabled");
  assert.equal(by.hasura.status, "on");
  assert.equal(by.g.status, "on");
  assert.deepEqual(report.warnings, []);
});

test("Windows backslash path on the command line", { skip: process.platform !== "win32" }, () => {
  const dir = project({ "sub/compose.yml": N8N_ON });
  assert.equal(run(["scan", "sub\\compose.yml"], dir).code, 1);
  assert.equal(run(["scan", `${dir}\\sub\\compose.yml`.replaceAll("/", "\\")]).code, 1);
  assert.equal(run(["scan", ".\\sub\\compose.yml", "--fix"], dir).code, 1);
});

// ---- size ----

test("a very large file (3000 services) scans quickly", () => {
  const images = ["n8nio/n8n:1.0.0", "postgres:16", "grafana/grafana@sha256:" + "ab".repeat(32), "registry.internal:5000/team/app:v1", "hasura/graphql-engine"];
  const body = Array.from({ length: 3000 }, (_, i) => `  svc${i}:\n    image: ${images[i % images.length]}\n    environment:\n      - A=${i}\n      - B=x\n`).join("");
  const dir = project({ "compose.yml": `services:\n${body}` });
  const started = Date.now();
  const res = scanJson(["scan", join(dir, "compose.yml")]);
  assert.equal(res.report.services.length, 3000);
  assert.equal(res.code, 1);
  assert.ok(Date.now() - started < 10000, `took ${Date.now() - started} ms`);
  assert.equal(run(["scan", join(dir, "compose.yml")]).code, 1);
  assert.equal(run(["blocklist", join(dir, "compose.yml")]).code, 0);
});

// ---- registries and digests ----

test("digests, with and without a tag", () => {
  const digest = `sha256:${"0123456789abcdef".repeat(4)}`;
  const dir = project({ "compose.yml": `services:\n  a:\n    image: n8nio/n8n@${digest}\n  b:\n    image: docker.io/n8nio/n8n:1.70.2@${digest}\n  c:\n    image: ghcr.io/immich-app/immich-machine-learning:v3.3.6@${digest}\n` });
  const { by } = scanJson(["scan", join(dir, "compose.yml")]);
  assert.equal(by.a.status, "on");
  assert.equal(by.b.status, "on");
  assert.equal(by.c.status, "fixed");
  const text = run(["scan", join(dir, "compose.yml")]).stdout;
  assert.match(text, /n8nio\/n8n@sha256:01234567\.\.\./, "digests are shortened in the table");
  assert.doesNotMatch(text, new RegExp(digest));
});

test("private registries and mirrors are not matched, but a hint is given", () => {
  const dir = project({
    "compose.yml": "services:\n  a:\n    image: registry.example.com:5000/n8nio/n8n:1.70.2\n  b:\n    image: harbor.corp.local/dockerhub/grafana/grafana:11\n  c:\n    image: registry.example.com/team/internal-tool:3\n  d:\n    image: localhost:5000/hasura/graphql-engine\n",
  });
  const { by, code } = scanJson(["scan", join(dir, "compose.yml")]);
  for (const s of ["a", "b", "c", "d"]) assert.equal(by[s].status, "not-in-database", s);
  assert.equal(by.a.possible_match, "n8nio/n8n");
  assert.equal(by.b.possible_match, "grafana/grafana");
  assert.equal(by.c.possible_match, null);
  assert.equal(by.d.possible_match, "hasura/graphql-engine");
  assert.equal(code, 0, "an unmatched image never fails the run");
  const text = run(["scan", join(dir, "compose.yml")]).stdout;
  assert.match(text, /looks like a mirror of n8nio\/n8n/);
  assert.match(run(["check", "registry.example.com:5000/n8nio/n8n:1"]).stdout, /looks like a mirror of n8nio\/n8n/);
});

// ---- partly opted out ----

test("only the optional variables set: still on, and --fix adds just the missing one", () => {
  const dir = project({ "compose.yml": `${N8N_ON}    environment:\n      - N8N_VERSION_NOTIFICATIONS_ENABLED=false\n      - N8N_TEMPLATES_ENABLED=false\n` });
  const { by } = scanJson(["scan", join(dir, "compose.yml")]);
  assert.equal(by.n8n.status, "on");
  assert.deepEqual(by.n8n.fix_env, [{ name: "N8N_DIAGNOSTICS_ENABLED", value: "false" }]);
  assert.deepEqual(by.n8n.optional_env, []);
});

test("telemetry off but update checks still on: OK, with the rest listed as optional", () => {
  const dir = project({ "compose.yml": "services:\n  grafana:\n    image: grafana/grafana\n    environment:\n      GF_ANALYTICS_REPORTING_ENABLED: 'false'\n" });
  const { by, code } = scanJson(["scan", join(dir, "compose.yml")]);
  assert.equal(by.grafana.status, "disabled");
  assert.deepEqual(by.grafana.optional_env.map((e) => e.name), ["GF_ANALYTICS_CHECK_FOR_UPDATES", "GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES"]);
  assert.equal(code, 0);
});

test("some services opted out and some not: only the rest are fixed", () => {
  const dir = project({
    "compose.yml": "services:\n  web:\n    image: chatwoot/chatwoot\n    environment:\n      - DISABLE_TELEMETRY=true\n  worker:\n    image: chatwoot/chatwoot\n  wrong:\n    image: chatwoot/chatwoot\n    environment:\n      - DISABLE_TELEMETRY=false\n",
  });
  const res = scanJson(["scan", join(dir, "compose.yml"), "--fix"]);
  assert.equal(res.by.web.status, "disabled");
  assert.equal(res.by.worker.status, "on");
  assert.equal(res.by.wrong.status, "on");
  const after = scanJson(["scan", join(dir, "compose.yml"), join(dir, "compose.phonehome.override.yml")]);
  assert.equal(after.code, 0);
  assert.equal(after.by.wrong.status, "disabled", "the override replaces a wrong value");
});

test("--fix with only manual opt-outs left says why no file was written", () => {
  const dir = project({ "compose.yml": "services:\n  db:\n    image: timescale/timescaledb:latest-pg16\n" });
  const res = run(["scan", join(dir, "compose.yml"), "--fix"]);
  assert.equal(res.code, 1);
  assert.match(res.stdout, /No override file written: the remaining opt-outs are manual steps/);
});

// ---- error messages ----

test("every usage error says what went wrong and what to do, with no stack trace", () => {
  const dir = project({ "docker-compose.yml": N8N_ON });
  const cases = [
    [["frobnicate"], /Unknown command: frobnicate/, /The commands are: scan, blocklist, check, list/],
    [["docker-compose.yml"], /Unknown command: docker-compose\.yml/, /Did you mean: phonehome scan docker-compose\.yml/],
    [["scan", "--nope"], /Unknown option: --nope/, /phonehome --help/],
    [["check"], /check needs an image name/, /phonehome check n8nio\/n8n/],
    [["check", "docker-compose.yml"], /is a file, and check takes an image name/, /phonehome scan docker-compose\.yml/],
    [["blocklist", "docker-compose.yml", "--format", "xml"], /Unknown blocklist format: xml/, /hosts, pihole, adguard/],
    [["blocklist", "docker-compose.yml", "--format"], /--format needs a value/, /--format pihole/],
    [["scan", "missing.yml"], /File not found: missing\.yml/, /Check the path/],
  ];
  for (const [args, what, todo] of cases) {
    const res = run(args, dir);
    assert.equal(res.code, 2, args.join(" "));
    assert.match(res.stderr, what, args.join(" "));
    assert.match(res.stderr, todo, args.join(" "));
    assert.equal(res.stderr.trim().split("\n").length <= 4, true, `short message for: ${args.join(" ")}`);
    noStack(res);
  }
});

test("--debug adds the stack trace", () => {
  const res = run(["scan", "missing.yml", "--debug"]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /File not found: missing\.yml/);
  assert.match(res.stderr, /\n\s+at .+:\d+:\d+/);
});

test("a failed --update explains itself and points at the offline path", () => {
  const res = spawnSync(process.execPath, [cli, "list", "--update"], { encoding: "utf8", env: { ...env, PHONEHOME_UPDATE_URL: "http://127.0.0.1:9/index.json" } });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /Could not download the database/);
  assert.match(res.stderr, /without --update/);
  assert.doesNotMatch(res.stderr, /\n\s+at .+:\d+:\d+/);
});

test("help and version", () => {
  assert.equal(run(["--help"]).code, 0);
  assert.match(run(["--help"]).stdout, /--debug/);
  assert.match(run(["--version"]).stdout, /^\d+\.\d+\.\d+/);
  assert.equal(run([]).code, 2);
});
