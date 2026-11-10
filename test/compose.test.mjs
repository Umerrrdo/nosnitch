import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnvironment, parseEnvFile, interpolate, loadCompose } from "../dist/compose.js";

function project(files) {
  const dir = mkdtempSync(join(tmpdir(), "nosnitch-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

test("environment in list form", () => {
  const env = parseEnvironment(["A=1", "B=two=parts", "PASSTHROUGH", "EMPTY="]);
  assert.equal(env.get("A"), "1");
  assert.equal(env.get("B"), "two=parts");
  assert.equal(env.has("PASSTHROUGH"), true);
  assert.equal(env.get("PASSTHROUGH"), undefined);
  assert.equal(env.get("EMPTY"), "");
});

test("environment in map form, including YAML booleans and numbers", () => {
  const env = parseEnvironment({ A: "x", FLAG: false, ON: true, NUM: 1, PASSTHROUGH: null });
  assert.equal(env.get("A"), "x");
  assert.equal(env.get("FLAG"), "false");
  assert.equal(env.get("ON"), "true");
  assert.equal(env.get("NUM"), "1");
  assert.equal(env.get("PASSTHROUGH"), undefined);
});

test("env file parsing", () => {
  const env = parseEnvFile('# comment\nA=1\nexport B="quoted value"\nC=\'single\'\nD=plain # trailing\n\nBARE\n');
  assert.equal(env.get("A"), "1");
  assert.equal(env.get("B"), "quoted value");
  assert.equal(env.get("C"), "single");
  assert.equal(env.get("D"), "plain");
  assert.equal(env.get("BARE"), undefined);
});

test("variable interpolation", () => {
  const vars = { SET: "yes", EMPTY: "" };
  assert.equal(interpolate("${SET}", vars), "yes");
  assert.equal(interpolate("$SET", vars), "yes");
  assert.equal(interpolate("${MISSING:-fallback}", vars), "fallback");
  assert.equal(interpolate("${EMPTY:-fallback}", vars), "fallback");
  assert.equal(interpolate("${EMPTY-fallback}", vars), "");
  assert.equal(interpolate("${MISSING}", vars), "");
  assert.equal(interpolate("$$literal", vars), "$literal");
});

test("env_file as string, list and object, with environment taking priority", () => {
  const dir = project({
    "a.env": "FROM_A=1\nSHARED=file\n",
    "b.env": "FROM_B=1\n",
    "compose.yml": [
      "services:",
      "  one:",
      "    image: x/one",
      "    env_file: a.env",
      "  two:",
      "    image: x/two",
      "    env_file:",
      "      - a.env",
      "      - path: b.env",
      "        required: false",
      "    environment:",
      "      SHARED: compose",
      "  three:",
      "    image: x/three",
      "    env_file: missing.env",
    ].join("\n"),
  });
  const { services, warnings } = loadCompose([join(dir, "compose.yml")]);
  const byName = Object.fromEntries(services.map((s) => [s.name, s]));
  assert.equal(byName.one.env.get("FROM_A"), "1");
  assert.equal(byName.two.env.get("FROM_B"), "1");
  assert.equal(byName.two.env.get("SHARED"), "compose");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /missing\.env not found/);
});

test(".env next to the compose file feeds interpolation", () => {
  const dir = project({
    ".env": "TELEMETRY=false\nTAG=1.2.3\n",
    "compose.yml": "services:\n  app:\n    image: x/app:${TAG}\n    environment:\n      - SOME_TELEMETRY=${TELEMETRY}\n",
  });
  const { services } = loadCompose([join(dir, "compose.yml")]);
  assert.equal(services[0].image, "x/app:1.2.3");
  assert.equal(services[0].env.get("SOME_TELEMETRY"), "false");
});

test("anchors and merge keys are resolved", () => {
  const dir = project({
    "compose.yml": "x-env: &env\n  SHARED_FLAG: 'false'\nservices:\n  app:\n    image: x/app\n    environment:\n      <<: *env\n      OWN: '1'\n",
  });
  const { services } = loadCompose([join(dir, "compose.yml")]);
  assert.equal(services[0].env.get("SHARED_FLAG"), "false");
  assert.equal(services[0].env.get("OWN"), "1");
});

test("later files override earlier ones", () => {
  const dir = project({
    "compose.yml": "services:\n  app:\n    image: x/app\n    environment:\n      - KEEP=1\n      - FLAG=true\n",
    "override.yml": "services:\n  app:\n    environment:\n      FLAG: 'false'\n",
  });
  const { services } = loadCompose([join(dir, "compose.yml"), join(dir, "override.yml")]);
  assert.equal(services.length, 1);
  assert.equal(services[0].image, "x/app");
  assert.equal(services[0].env.get("KEEP"), "1");
  assert.equal(services[0].env.get("FLAG"), "false");
});
