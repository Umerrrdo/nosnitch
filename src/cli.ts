#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { BLOCKLIST_FORMATS, isBlocklistFormat, renderBlocklist } from "./blocklist.js";
import { DEFAULT_COMPOSE_FILES, displayPath, findComposeFile, loadCompose } from "./compose.js";
import { loadDatabase } from "./db.js";
import { NosnitchError, UsageError } from "./errors.js";
import { writeOverride } from "./fix.js";
import { renderCheck, renderList, renderScan } from "./render.js";
import { checkImage, exitCodeFor, scanServices } from "./scanner.js";

const HELP = `nosnitch: which apps in your Docker Compose file send telemetry by default?

Usage:
  nosnitch scan [compose-file] [more-files...]   table of services, defaults, destinations and fixes
  nosnitch scan [compose-file] --fix             write compose.nosnitch.override.yml (your file is never edited)
  nosnitch blocklist [compose-file]              telemetry destinations in hosts-file format
  nosnitch check <image>                         look up one image
  nosnitch list                                  list every app in the database

Without a compose file, nosnitch looks in the current folder for
${DEFAULT_COMPOSE_FILES.join(", ")}.

Options:
  --json       machine-readable output (scan, check, list)
  --format     blocklist format: hosts (default), pihole (plain domains) or adguard (||domain^)
  --update     download the latest database first (the only network call nosnitch ever makes)
  --debug      show the full stack trace when something fails
  -h, --help
  -v, --version

Exit codes:
  0  nothing known is left on
  1  scan found telemetry that is on by default and not disabled
  2  usage or file error
`;

const COMMANDS = ["scan", "blocklist", "check", "list"];

function version(): string {
  const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version;
}

/** Uses the files given, or finds the compose file in the current folder (or in a folder that was passed). */
function composeFiles(args: string[], command: string): string[] {
  if (args.length === 0) {
    const found = findComposeFile(process.cwd());
    if (found) return [found];
    throw new UsageError(
      `No compose file given and none found in ${process.cwd()}.`,
      `Pass one, for example: nosnitch ${command} docker-compose.yml\nnosnitch looks for: ${DEFAULT_COMPOSE_FILES.join(", ")}.`,
    );
  }
  return args.map((arg) => (existsSync(arg) && statSync(arg).isDirectory() ? (findComposeFile(arg) ?? arg) : arg));
}

function quote(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path;
}

function parse(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: "boolean", default: false },
        fix: { type: "boolean", default: false },
        format: { type: "string", default: "hosts" },
        update: { type: "boolean", default: false },
        debug: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (err) {
    const e = err as Error & { code?: string };
    if (e.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      const option = /'([^']+)'/.exec(e.message)?.[1] ?? "that option";
      throw new UsageError(`Unknown option: ${option}`);
    }
    if (e.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      throw new UsageError(`--format needs a value: ${BLOCKLIST_FORMATS.join(", ")}.`, "For example: nosnitch blocklist docker-compose.yml --format pihole");
    }
    throw err;
  }
}

async function main(argv: string[]): Promise<number> {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 20) {
    throw new NosnitchError(
      `nosnitch needs Node 20 or newer. This is Node ${process.versions.node}.`,
      "Install a current Node from https://nodejs.org, or use the Docker image (see the README).",
    );
  }
  const { values, positionals } = parse(argv);
  const [command, ...rest] = positionals;

  if (values.version) {
    console.log(version());
    return 0;
  }
  if (values.help || (!command && !values.update)) {
    console.log(HELP);
    return values.help ? 0 : 2;
  }
  if (command && !COMMANDS.includes(command)) {
    const looksLikeFile = /\.ya?ml$/i.test(command) || existsSync(command);
    throw new UsageError(
      `Unknown command: ${command}`,
      looksLikeFile ? `Did you mean: nosnitch scan ${quote(command)}` : `The commands are: ${COMMANDS.join(", ")}. Run nosnitch --help for details.`,
    );
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
      const files = composeFiles(rest, "scan");
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
          console.log(`\nWrote ${displayPath(written)}`);
          console.log(`Apply it: docker compose -f ${quote(displayPath(files[0] as string))} -f ${quote(displayPath(written))} up -d`);
        } else if (values.fix) {
          const manual = results.some((r) => !r.ok && r.manual.length > 0);
          console.log(`\nNo override file written: ${manual ? "the remaining opt-outs are manual steps, not environment variables." : "no environment fixes are needed."}`);
        }
      }
      return exitCode;
    }
    case "blocklist": {
      const format = values.format ?? "hosts";
      if (!isBlocklistFormat(format)) {
        throw new UsageError(`Unknown blocklist format: ${format}`, `Use one of: ${BLOCKLIST_FORMATS.join(", ")}. For example: nosnitch blocklist docker-compose.yml --format pihole`);
      }
      const project = loadCompose(composeFiles(rest, "blocklist"));
      console.log(renderBlocklist(scanServices(project.services, db.apps), format));
      return 0;
    }
    case "check": {
      const image = rest[0];
      if (!image) throw new UsageError("check needs an image name.", "For example: nosnitch check n8nio/n8n");
      if (/\.ya?ml$/i.test(image) && existsSync(image)) {
        throw new UsageError(`${image} is a file, and check takes an image name.`, `To scan a compose file run: nosnitch scan ${quote(image)}`);
      }
      const result = checkImage(image, db.apps);
      console.log(values.json ? JSON.stringify(result, null, 2) : renderCheck(result));
      return 0;
    }
    default: {
      console.log(values.json ? JSON.stringify(db.apps, null, 2) : renderList(db.apps));
      return 0;
    }
  }
}

const debug = process.argv.includes("--debug");

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.exitCode = 2;
    if (err instanceof NosnitchError) {
      console.error(`nosnitch: ${err.message}`);
      if (err.hint) console.error(err.hint);
    } else {
      // Not an error we planned for. Still no stack trace unless asked.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`nosnitch: something went wrong: ${message}`);
      console.error("Run it again with --debug for details, and please report it: https://github.com/Umerrrdo/nosnitch/issues");
    }
    if (debug && err instanceof Error && err.stack) console.error(`\n${err.stack}`);
  },
);
