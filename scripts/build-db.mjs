#!/usr/bin/env node
// Validates db/apps/*.yaml against db/schema.json and writes db/index.json.
// With --check it writes nothing and fails if db/index.json is out of date.
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appsDir = join(root, "db", "apps");
const indexPath = join(root, "db", "index.json");
const check = process.argv.includes("--check");

const schema = JSON.parse(readFileSync(join(root, "db", "schema.json"), "utf8"));
const validate = new Ajv({ allErrors: true }).compile(schema);

const errors = [];
const apps = [];
const seenImages = new Map();

for (const file of readdirSync(appsDir).filter((f) => f.endsWith(".yaml")).sort()) {
  let entry;
  try {
    entry = parse(readFileSync(join(appsDir, file), "utf8"));
  } catch (err) {
    errors.push(`${file}: invalid YAML: ${err.message}`);
    continue;
  }
  if (!validate(entry)) {
    for (const e of validate.errors) errors.push(`${file}: ${e.instancePath || "/"} ${e.message}`);
    continue;
  }
  if (entry.slug !== basename(file, ".yaml")) {
    errors.push(`${file}: slug "${entry.slug}" must match the file name`);
  }
  for (const image of entry.images) {
    if (seenImages.has(image)) errors.push(`${file}: image "${image}" is already used by ${seenImages.get(image)}`);
    seenImages.set(image, file);
  }
  apps.push(entry);
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  console.error(`\n${errors.length} problem(s) in the database.`);
  process.exit(1);
}

const index = { schema_version: 1, apps };

if (check) {
  const current = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : null;
  if (JSON.stringify(current) !== JSON.stringify(index)) {
    console.error("db/index.json is out of date. Run: npm run build:db");
    process.exit(1);
  }
  console.log(`${apps.length} entries valid, db/index.json is up to date.`);
} else {
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");
  console.log(`Wrote db/index.json with ${apps.length} entries.`);
}
