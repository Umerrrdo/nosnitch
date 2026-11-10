import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadCompose } from "../dist/compose.js";
import { scanServices, checkImage, exitCodeFor } from "../dist/scanner.js";

const { apps } = JSON.parse(readFileSync(new URL("../db/index.json", import.meta.url), "utf8"));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const scan = (name) => {
  const results = scanServices(loadCompose([fixture(name)]).services, apps);
  return { results, by: Object.fromEntries(results.map((r) => [r.service, r])) };
};
const svc = (image, environment, command = "") => [{ name: "s", image, env: new Map(Object.entries(environment)), command }];

test("example compose: statuses", () => {
  const { by, results } = scan("example-compose.yml");
  assert.equal(by.n8n.status, "on");
  assert.deepEqual(by.n8n.fix_env, [{ name: "N8N_DIAGNOSTICS_ENABLED", value: "false" }]);
  assert.equal(by.grafana.status, "disabled");
  assert.equal(by.meilisearch.status, "disabled");
  assert.equal(by["langfuse-web"].status, "disabled");
  assert.equal(by.hasura.status, "on");
  assert.deepEqual(by.hasura.destinations, ["telemetry.hasura.io"]);
  assert.equal(by["immich-machine-learning"].status, "on");
  assert.equal(by.postgres.status, "not-in-database");
  assert.equal(by["internal-api"].status, "no-image");
  assert.equal(exitCodeFor(results), 1);
});

test("clean compose: everything OK", () => {
  const { by, results } = scan("clean-compose.yml");
  assert.equal(by.n8n.status, "disabled");
  assert.equal(by.qdrant.status, "disabled");
  assert.deepEqual(by.qdrant.detected, ["--disable-telemetry"]);
  assert.equal(by.netdata.status, "disabled");
  assert.equal(by["immich-machine-learning"].status, "fixed");
  assert.equal(by.redis.status, "not-in-database");
  assert.equal(exitCodeFor(results), 0);
});

test("unverified and unknown entries are reported but do not fail the run", () => {
  const { by, results } = scan("unverified-compose.yml");
  assert.equal(by.firezone.status, "on");
  assert.equal(by.firezone.verified, false);
  assert.equal(by["novu-api"].status, "unknown");
  assert.equal(exitCodeFor(results), 0);
});

test("a wrong value does not count as disabled", () => {
  const [r] = scanServices(svc("n8nio/n8n", { N8N_DIAGNOSTICS_ENABLED: "true" }), apps);
  assert.equal(r.status, "on");
  assert.equal(r.fix_env.length, 1);
});

test("a variable passed through from the host is not assumed to be set", () => {
  const services = [{ name: "s", image: "n8nio/n8n", env: new Map([["N8N_DIAGNOSTICS_ENABLED", undefined]]), command: "" }];
  assert.equal(scanServices(services, apps)[0].status, "on");
});

test("values compare case-insensitively and accepted values count", () => {
  assert.equal(scanServices(svc("n8nio/n8n", { N8N_DIAGNOSTICS_ENABLED: "FALSE" }), apps)[0].status, "disabled");
  assert.equal(scanServices(svc("ghcr.io/every-app/open-seo-standalone", { OPENSEO_TELEMETRY_DISABLED: "1" }), apps)[0].status, "disabled");
  assert.equal(scanServices(svc("ghcr.io/every-app/open-seo-standalone", { DO_NOT_TRACK: "1" }), apps)[0].status, "disabled");
  assert.equal(scanServices(svc("ghcr.io/every-app/open-seo-standalone", { OPENSEO_TELEMETRY_DISABLED: "off" }), apps)[0].status, "on");
});

test("optional variables are not required for OK and are listed separately", () => {
  const [r] = scanServices(svc("n8nio/n8n", { N8N_DIAGNOSTICS_ENABLED: "false" }), apps);
  assert.equal(r.status, "disabled");
  assert.deepEqual(r.optional_env.map((e) => e.name), ["N8N_VERSION_NOTIFICATIONS_ENABLED", "N8N_TEMPLATES_ENABLED"]);
});

test("apps with only manual or config opt-outs stay flagged and get no env fix", () => {
  const [r] = scanServices(svc("timescale/timescaledb:latest-pg16", {}), apps);
  assert.equal(r.status, "on");
  assert.deepEqual(r.fix_env, []);
  assert.equal(r.manual.length, 1);
});

test("env var set on a fixed_in app counts even on a moving tag", () => {
  const image = "ghcr.io/immich-app/immich-machine-learning:release";
  assert.equal(scanServices(svc(image, {}), apps)[0].status, "on");
  assert.equal(scanServices(svc(image, { ORT_DISABLE_TELEMETRY: "1" }), apps)[0].status, "disabled");
});

test("checkImage", () => {
  assert.equal(checkImage("n8nio/n8n:latest", apps).slug, "n8n");
  assert.equal(checkImage("nginx", apps).status, "not-in-database");
});
