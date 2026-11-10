import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parse } from "yaml";
import { NosnitchError } from "./errors.js";

export interface ComposeService {
  name: string;
  image?: string;
  /** Variables used in the image name that are not set anywhere, so the image could not be fully resolved. */
  unsetImageVars?: string[];
  /** Resolved environment. undefined means the variable is passed through from the host, so its value is not known. */
  env: Map<string, string | undefined>;
  /** command and entrypoint joined into one string, used to look for CLI flags. */
  command: string;
}

export interface ComposeProject {
  services: ComposeService[];
  warnings: string[];
}

type Vars = Record<string, string | undefined>;
type RawServices = Record<string, unknown>;

/** The file names Docker Compose looks for, in its order of preference. */
export const DEFAULT_COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

/** Finds the compose file in a directory the way `docker compose` does. */
export function findComposeFile(dir: string): string | undefined {
  return DEFAULT_COMPOSE_FILES.map((name) => resolve(dir, name)).find((path) => existsSync(path) && statSync(path).isFile());
}

/** Parses KEY=VALUE lines as used by env_file and .env. */
export function parseEnvFile(text: string): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  for (const rawLine of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, "");
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) {
      out.set(line, undefined);
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2] ?? "";
    else value = value.replace(/\s+#.*$/, "");
    if (key !== "") out.set(key, value);
  }
  return out;
}

export interface InterpolateOptions {
  /** Names of variables that were needed but not set are added here. */
  missing?: Set<string>;
  /** Leave an unset variable as written instead of replacing it with an empty string. */
  keepMissing?: boolean;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;

/**
 * Resolves $VAR, ${VAR}, ${VAR:-default}, ${VAR-default}, ${VAR:+alt}, ${VAR+alt}
 * and ${VAR:?error} the way Compose does, including nested defaults such as
 * ${A:-${B:-1}}. "$$" is a literal dollar sign.
 */
export function interpolate(value: string, vars: Vars, options: InterpolateOptions = {}): string {
  let out = "";
  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    if (ch !== "$") {
      out += ch;
      i++;
      continue;
    }
    if (value[i + 1] === "$") {
      out += "$";
      i += 2;
      continue;
    }
    if (value[i + 1] === "{") {
      // Find the matching brace, allowing nested ${...} in the default.
      let depth = 1;
      let j = i + 2;
      while (j < value.length && depth > 0) {
        if (value[j] === "$" && value[j + 1] === "{") {
          depth++;
          j++;
        } else if (value[j] === "}") depth--;
        j++;
      }
      const body = value.slice(i + 2, j - 1);
      const name = depth === 0 ? NAME.exec(body)?.[0] : undefined;
      if (!name) {
        out += ch;
        i++;
        continue;
      }
      const rest = body.slice(name.length);
      const op = /^(:?[-?+])/.exec(rest)?.[1];
      const arg = op ? rest.slice(op.length) : "";
      const current = vars[name];
      const isSet = op?.startsWith(":") ? Boolean(current) : current !== undefined;
      const literal = value.slice(i, j);
      if (op === undefined) out += current ?? missing(name, literal, options);
      else if (op.endsWith("-")) out += isSet ? current : interpolate(arg, vars, options);
      else if (op.endsWith("+")) out += isSet ? interpolate(arg, vars, options) : "";
      else out += isSet ? current : missing(name, literal, options);
      i = j;
      continue;
    }
    const bare = NAME.exec(value.slice(i + 1))?.[0];
    if (!bare) {
      out += ch;
      i++;
      continue;
    }
    out += vars[bare] ?? missing(bare, `$${bare}`, options);
    i += 1 + bare.length;
  }
  return out;
}

function missing(name: string, literal: string, options: InterpolateOptions): string {
  options.missing?.add(name);
  return options.keepMissing ? literal : "";
}

function scalarToString(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

/** Reads the environment key in list form (- KEY=value) or map form (KEY: value). */
export function parseEnvironment(environment: unknown, vars: Vars = {}): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  if (Array.isArray(environment)) {
    for (const item of environment) {
      const entry = scalarToString(item);
      const eq = entry.indexOf("=");
      if (eq === -1) out.set(entry.trim(), undefined);
      else out.set(entry.slice(0, eq).trim(), interpolate(entry.slice(eq + 1), vars));
    }
  } else if (typeof environment === "object" && environment !== null) {
    for (const [key, value] of Object.entries(environment)) {
      out.set(key, value === null ? undefined : interpolate(scalarToString(value), vars));
    }
  }
  return out;
}

interface EnvFileRef {
  path: string;
  required: boolean;
}

function envFileRefs(envFile: unknown, dir: string, vars: Vars): EnvFileRef[] {
  const list = Array.isArray(envFile) ? envFile : envFile === undefined || envFile === null ? [] : [envFile];
  const refs: EnvFileRef[] = [];
  for (const item of list) {
    const isObject = typeof item === "object" && item !== null;
    const path = isObject ? (item as { path?: unknown }).path : item;
    if (typeof path !== "string") continue;
    const required = isObject ? (item as { required?: unknown }).required !== false : true;
    refs.push({ path: resolvePath(dir, interpolate(path, vars)), required });
  }
  return refs;
}

/** Accepts both slash styles, so a Windows path in a compose file also works. */
function resolvePath(dir: string, path: string): string {
  return resolve(dir, process.platform === "win32" ? path : path.replace(/\\/g, "/"));
}

function commandToString(...parts: unknown[]): string {
  return parts
    .flatMap((part) => (Array.isArray(part) ? part : part === undefined || part === null ? [] : [part]))
    .map(scalarToString)
    .join(" ");
}

/** Shows a path the way the user would type it. */
export function displayPath(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

/** Reads and parses one compose file, turning every failure into a message the user can act on. */
function readComposeFile(file: string): Record<string, unknown> {
  const shown = displayPath(file);
  if (!existsSync(file)) {
    throw new NosnitchError(`File not found: ${shown}`, "Check the path. Run nosnitch from the folder that holds your compose file, or pass the full path.");
  }
  if (statSync(file).isDirectory()) {
    throw new NosnitchError(
      `${shown} is a folder and has no compose file in it.`,
      `Pass the compose file itself. nosnitch looks for: ${DEFAULT_COMPOSE_FILES.join(", ")}.`,
    );
  }
  let text: string;
  try {
    text = readFileSync(file, "utf8").replace(/^﻿/, "");
  } catch (err) {
    throw new NosnitchError(`Could not read ${shown}: ${(err as Error).message}`, "Check that the file exists and that you have permission to read it.");
  }
  if (text.trim() === "") {
    throw new NosnitchError(`${shown} is empty.`, "A compose file needs a services: section. Check that you passed the right file.");
  }
  let doc: unknown;
  try {
    // Large official compose files (Sentry, for one) reuse anchors hundreds of times.
    doc = parse(text, { merge: true, maxAliasCount: 100000 });
  } catch (err) {
    throw new NosnitchError(
      `${shown} is not valid YAML.\n${(err as Error).message.trim()}`,
      `Fix the line shown above. "docker compose -f ${shown} config" reports the same problem.`,
    );
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new NosnitchError(`${shown} does not look like a Compose file.`, "A compose file is a YAML document with a top-level services: section.");
  }
  return doc as Record<string, unknown>;
}

interface Contribution {
  image?: string;
  unsetImageVars?: string[];
  envFiles: EnvFileRef[];
  environment: Map<string, string | undefined>;
  command: string;
}

interface LoadContext {
  vars: Vars;
  warnings: Set<string>;
  merged: Map<string, Contribution>;
  /** Files already loaded through include, to stop a loop. */
  included: Set<string>;
}

function asServices(doc: Record<string, unknown>): RawServices {
  const services = doc.services;
  return typeof services === "object" && services !== null && !Array.isArray(services) ? (services as RawServices) : {};
}

/** Works out what one service definition contributes, following extends first. */
function contribution(name: string, services: RawServices, file: string, ctx: LoadContext, chain: string[] = []): Contribution {
  const dir = dirname(file);
  const raw = services[name];
  const def = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  let out: Contribution = { envFiles: [], environment: new Map(), command: "" };

  if (def.extends !== undefined && def.extends !== null) {
    const ext = typeof def.extends === "string" ? { service: def.extends } : (def.extends as { service?: unknown; file?: unknown });
    const baseName = typeof ext.service === "string" ? ext.service : undefined;
    const baseFile = typeof ext.file === "string" ? resolvePath(dir, interpolate(ext.file, ctx.vars)) : file;
    const key = `${baseFile}#${baseName}`;
    if (!baseName) {
      ctx.warnings.add(`service "${name}": extends has no service name, so it was ignored`);
    } else if (chain.includes(key)) {
      ctx.warnings.add(`service "${name}": extends forms a loop, so it was ignored`);
    } else if (!existsSync(baseFile)) {
      ctx.warnings.add(`${displayPath(baseFile)} not found, so services that extend it are missing whatever it sets (image, environment)`);
    } else {
      const baseServices = baseFile === file ? services : asServices(readComposeFile(baseFile));
      if (baseName in baseServices) out = contribution(baseName, baseServices, baseFile, ctx, [...chain, key]);
      else ctx.warnings.add(`service "${name}": extends "${baseName}", which is not in ${displayPath(baseFile)}`);
    }
  }

  if (typeof def.image === "string") {
    const unset = new Set<string>();
    out.image = interpolate(def.image, ctx.vars, { missing: unset, keepMissing: true }).trim();
    if (unset.size > 0) out.unsetImageVars = [...unset];
    else delete out.unsetImageVars;
  }
  out.envFiles = [...out.envFiles, ...envFileRefs(def.env_file, dir, ctx.vars)];
  out.environment = new Map([...out.environment, ...parseEnvironment(def.environment, ctx.vars)]);
  const command = commandToString(def.entrypoint, def.command);
  if (command !== "") out.command = interpolate(command, ctx.vars);
  return out;
}

function loadFile(file: string, ctx: LoadContext): void {
  const doc = readComposeFile(file);
  const dir = dirname(file);

  const includes = Array.isArray(doc.include) ? doc.include : [];
  for (const item of includes) {
    const paths = typeof item === "string" ? [item] : ([(item as { path?: unknown } | null)?.path].flat() as unknown[]);
    for (const p of paths) {
      if (typeof p !== "string") continue;
      const target = resolvePath(dir, interpolate(p, ctx.vars));
      if (ctx.included.has(target)) continue;
      ctx.included.add(target);
      if (!existsSync(target)) {
        ctx.warnings.add(`${displayPath(file)} includes ${displayPath(target)}, which was not found, so its services were not scanned`);
        continue;
      }
      loadFile(target, ctx);
    }
  }

  const services = asServices(doc);
  for (const name of Object.keys(services)) {
    const next = contribution(name, services, file, ctx);
    const current = ctx.merged.get(name);
    if (!current) {
      ctx.merged.set(name, next);
      continue;
    }
    // A later file overrides an earlier one, like `docker compose -f a.yml -f b.yml`.
    if (next.image !== undefined) {
      current.image = next.image;
      if (next.unsetImageVars) current.unsetImageVars = next.unsetImageVars;
      else delete current.unsetImageVars;
    }
    current.envFiles.push(...next.envFiles);
    for (const [k, v] of next.environment) current.environment.set(k, v);
    if (next.command !== "") current.command = next.command;
  }
}

/**
 * Loads one or more compose files. Later files override earlier ones, like
 * `docker compose -f a.yml -f b.yml`. include and extends are followed.
 * Nothing is written and nothing is fetched.
 */
export function loadCompose(files: string[]): ComposeProject {
  const paths = files.map((f) => resolve(f));
  const firstDir = dirname(paths[0] ?? resolve("."));
  const dotEnvPath = resolve(firstDir, ".env");
  const dotEnv =
    existsSync(dotEnvPath) && statSync(dotEnvPath).isFile() ? parseEnvFile(readFileSync(dotEnvPath, "utf8")) : new Map<string, string | undefined>();
  const ctx: LoadContext = {
    vars: { ...Object.fromEntries(dotEnv), ...process.env },
    warnings: new Set(),
    merged: new Map(),
    included: new Set(paths),
  };

  for (const path of paths) loadFile(path, ctx);

  if (ctx.merged.size === 0) {
    const shown = paths.map(displayPath).join(", ");
    throw new NosnitchError(
      `No services found in ${shown}, so there is nothing to scan.`,
      "Is this a Docker Compose file? It needs a top-level services: section with at least one service.",
    );
  }

  const missingEnvFiles = new Map<string, string[]>();
  const services: ComposeService[] = [];
  for (const [name, svc] of ctx.merged) {
    const env = new Map<string, string | undefined>();
    for (const ref of svc.envFiles) {
      if (!existsSync(ref.path) || !statSync(ref.path).isFile()) {
        if (ref.required) missingEnvFiles.set(ref.path, [...(missingEnvFiles.get(ref.path) ?? []), name]);
        continue;
      }
      for (const [k, v] of parseEnvFile(readFileSync(ref.path, "utf8"))) env.set(k, v === undefined ? undefined : interpolate(v, ctx.vars));
    }
    // environment wins over env_file, as in Compose.
    for (const [k, v] of svc.environment) env.set(k, v);
    services.push({
      name,
      ...(svc.image ? { image: svc.image } : {}),
      ...(svc.unsetImageVars ? { unsetImageVars: svc.unsetImageVars } : {}),
      env,
      command: svc.command,
    });
  }

  const warnings = [...ctx.warnings];
  for (const [path, users] of missingEnvFiles) {
    warnings.push(`env_file ${displayPath(path)} not found (used by ${users.join(", ")}). Variables set in it could not be checked.`);
  }
  return { services, warnings };
}
