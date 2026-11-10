#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadCompose } from "./compose.js";
import { loadDatabase } from "./db.js";
import { writeOverride } from "./fix.js";
import { renderCheck, renderList, renderScan } from "./render.js";
import { checkImage, exitCodeFor, scanServices } from "./scanner.js";

const HELP = `phonehome: which apps in your Docker Compose file send telemetry by default?

Usage:
  phonehome scan <compose-file> [more-files...]   table of services, defaults, destinations and fixes
  phonehome scan <compose-file> --fix             write compose.phonehome.override.yml (your file is never edited)
  phonehome check <image>                         look up one image
  phonehome list                                  list every app in the database

Options:
  --json       machine-readable output (scan, check, list)
  --update     download the latest database first (the only network call phonehome ever makes)
  -h, --help
  -v, --version

Exit codes:
  0  nothing known is left on
  1  scan found telemetry that is on by default and not disabled
  2  usage or file error
`;

class UsageError extends Error {}

function version(): string {
  const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version;
}

function requireFiles(files: string[], command: string): string[] {
  if (files.length === 0) throw new UsageError(`${command} needs a compose file, for example: phonehome ${command} docker-compose.yml`);
  for (const file of files) if (!existsSync(file)) throw new UsageError(`file not found: ${file}`);
  return files;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      fix: { type: "boolean", default: false },
      update: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  const [command, ...rest] = positionals;

  if (values.version) {
    console.log(version());
    return 0;
  }
  if (values.help || (!command && !values.update)) {
    console.log(HELP);
    return values.help ? 0 : 2;
  }

  if (values.update) {
    const { updateDatabase } = await import("./update.js");
    const count = await updateDatabase();
    console.error(`Database updated: ${count} apps.`);
    if (!command) return 0;
  }

  const { db, source } = loadDatabase();

  switch (command) {
    case "scan": {
      const files = requireFiles(rest, "scan");
      const project = loadCompose(files);
      const results = scanServices(project.services, db.apps);
      const exitCode = exitCodeFor(results);
      const written = values.fix ? writeOverride(results, files[0] as string) : null;
      if (values.json) {
        const report = { files, database: { source, apps: db.apps.length }, services: results, warnings: project.warnings, override_file: written, exit_code: exitCode };
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(renderScan(results, project.warnings));
        if (written) {
          console.log(`\nWrote ${written}`);
          console.log(`Apply it: docker compose -f ${files[0]} -f ${written} up -d`);
        } else if (values.fix) {
          console.log("\nNothing to write: no environment fixes are needed.");
        }
      }
      return exitCode;
    }
    case "check": {
      const image = rest[0];
      if (!image) throw new UsageError("check needs an image, for example: phonehome check n8nio/n8n");
      const result = checkImage(image, db.apps);
      console.log(values.json ? JSON.stringify(result, null, 2) : renderCheck(result));
      return 0;
    }
    case "list": {
      console.log(values.json ? JSON.stringify(db.apps, null, 2) : renderList(db.apps));
      return 0;
    }
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`phonehome: ${message}`);
    if (err instanceof UsageError) console.error("Run phonehome --help for usage.");
    process.exitCode = 2;
  },
);
