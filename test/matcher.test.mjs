import { test } from "node:test";
import assert from "node:assert/strict";
import { parseImage, matchesPattern, findApp, isAtLeastVersion } from "../dist/matcher.js";

const apps = [
  { slug: "n8n", images: ["n8nio/n8n", "docker.n8n.io/n8nio/n8n"] },
  { slug: "immich-ml", images: ["ghcr.io/immich-app/immich-machine-learning"] },
  { slug: "influx", images: ["influxdb"] },
];
const slugOf = (image) => findApp(image, apps)?.slug;

test("parseImage splits tag and digest", () => {
  assert.deepEqual(parseImage("n8nio/n8n:1.70.2"), { name: "n8nio/n8n", tag: "1.70.2" });
  assert.deepEqual(parseImage("n8nio/n8n@sha256:abc"), { name: "n8nio/n8n", digest: "sha256:abc" });
  assert.deepEqual(parseImage("n8nio/n8n:1.70.2@sha256:abc"), { name: "n8nio/n8n", tag: "1.70.2", digest: "sha256:abc" });
  assert.deepEqual(parseImage("n8nio/n8n"), { name: "n8nio/n8n" });
});

test("a registry port is not mistaken for a tag", () => {
  assert.deepEqual(parseImage("localhost:5000/n8nio/n8n"), { name: "localhost:5000/n8nio/n8n" });
  assert.deepEqual(parseImage("registry.local:5000/n8nio/n8n:2"), { name: "registry.local:5000/n8nio/n8n", tag: "2" });
});

test("Docker Hub prefixes are normalised away", () => {
  assert.equal(parseImage("docker.io/n8nio/n8n:latest").name, "n8nio/n8n");
  assert.equal(parseImage("index.docker.io/n8nio/n8n").name, "n8nio/n8n");
  assert.equal(parseImage("docker.io/library/influxdb:2").name, "influxdb");
  assert.equal(parseImage("library/influxdb").name, "influxdb");
  assert.equal(parseImage("N8NIO/N8N").name, "n8nio/n8n");
});

test("findApp matches across registry prefixes, tags and digests", () => {
  assert.equal(slugOf("n8nio/n8n"), "n8n");
  assert.equal(slugOf("n8nio/n8n:latest"), "n8n");
  assert.equal(slugOf("docker.io/n8nio/n8n:1.70.2"), "n8n");
  assert.equal(slugOf("docker.n8n.io/n8nio/n8n:next"), "n8n");
  assert.equal(slugOf("n8nio/n8n@sha256:0123abcd"), "n8n");
  assert.equal(slugOf("ghcr.io/immich-app/immich-machine-learning:v3.3.5-cuda"), "immich-ml");
  assert.equal(slugOf("docker.io/library/influxdb:2.7"), "influx");
});

test("findApp does not guess", () => {
  assert.equal(slugOf("n8nio/n8n-runner"), undefined);
  assert.equal(slugOf("someone/n8n"), undefined);
  assert.equal(slugOf("ghcr.io/n8nio/n8n"), undefined);
  assert.equal(slugOf("ghcr.io/immich-app/immich-server:release"), undefined);
  assert.equal(slugOf("myregistry.example.com/library/influxdb"), undefined);
});

test("wildcard patterns", () => {
  assert.equal(matchesPattern("ghcr.io/acme/app-worker:1", "ghcr.io/acme/app-*"), true);
  assert.equal(matchesPattern("ghcr.io/acme/other", "ghcr.io/acme/app-*"), false);
  assert.equal(matchesPattern("ghcr.io/acmeXapp", "ghcr.io/acme.app"), false);
});

test("isAtLeastVersion", () => {
  assert.equal(isAtLeastVersion("v3.3.6", "3.3.6"), true);
  assert.equal(isAtLeastVersion("3.4.0", "3.3.6"), true);
  assert.equal(isAtLeastVersion("v3.3.6-cuda", "3.3.6"), true);
  assert.equal(isAtLeastVersion("v3.3.5", "3.3.6"), false);
  assert.equal(isAtLeastVersion("2.9.9", "3.3.6"), false);
  assert.equal(isAtLeastVersion("v4", "3.3.6"), true);
  assert.equal(isAtLeastVersion("v3", "3.3.6"), false);
  assert.equal(isAtLeastVersion("3.3", "3.3.6"), false);
  assert.equal(isAtLeastVersion("release", "3.3.6"), false);
  assert.equal(isAtLeastVersion(undefined, "3.3.6"), false);
});
