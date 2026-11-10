#!/usr/bin/env node
// Checks that every source URL in the database responds.
// A page that is gone (404 or 410) fails the run. Timeouts, network errors,
// rate limits and bot blocks only warn, because they say nothing about the page.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { apps } = JSON.parse(readFileSync(join(root, "db", "index.json"), "utf8"));
const TIMEOUT_MS = 20000;

const urls = new Map();
for (const app of apps) for (const url of app.sources) urls.set(url, [...(urls.get(url) ?? []), app.slug]);

async function probe(url) {
  for (const method of ["HEAD", "GET"]) {
    try {
      const res = await fetch(url, {
        method,
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "user-agent": "nosnitch-source-check" },
      });
      if (res.ok) return { state: "ok", detail: String(res.status) };
      if (method === "HEAD") continue;
      return { state: res.status === 404 || res.status === 410 ? "gone" : "warn", detail: `HTTP ${res.status}` };
    } catch (err) {
      if (method === "HEAD") continue;
      return { state: "warn", detail: err.name === "TimeoutError" ? "timed out" : (err.cause?.code ?? err.message) };
    }
  }
}

let gone = 0;
let warned = 0;
for (const [url, slugs] of urls) {
  const { state, detail } = await probe(url);
  if (state === "ok") continue;
  const line = `${url} (${slugs.join(", ")}): ${detail}`;
  if (state === "gone") {
    gone++;
    console.error(`FAIL ${line}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::error::Source is gone: ${line}`);
  } else {
    warned++;
    console.warn(`WARN ${line}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::warning::Source did not respond cleanly: ${line}`);
  }
}

console.log(`${urls.size} source URLs checked: ${urls.size - gone - warned} ok, ${warned} warning(s), ${gone} gone.`);
process.exit(gone > 0 ? 1 : 0);
