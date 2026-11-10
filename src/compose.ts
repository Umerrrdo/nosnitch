import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";

export interface ComposeService {
  name: string;
  image?: string;
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

/** Parses KEY=VALUE lines as used by env_file and .env. */
export function parseEnvFile(text: string): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  for (const rawLine of text.split(/\r?\n/)) {
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

/** Resolves ${VAR}, ${VAR:-default}, ${VAR-default} and $VAR the way Compose does. */
export function interpolate(value: string, vars: Vars): string {
  return value.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, op, arg, bare) => {
    if (match === "$$") return "$";
    const current = vars[braced ?? bare];
    if (op === ":-") return current ? current : (arg ?? "");
    if (op === "-") return current !== undefined ? current : (arg ?? "");
    if (op === ":+") return current ? (arg ?? "") : "";
    if (op === "+") return current !== undefined ? (arg ?? "") : "";
    return current ?? "";
  });
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

function envFilePaths(envFile: unknown): string[] {
  const list = Array.isArray(envFile) ? envFile : envFile === undefined || envFile === null ? [] : [envFile];
  return list
    .map((item) => (typeof item === "object" && item !== null ? (item as { path?: unknown }).path : item))
    .filter((p): p is string => typeof p === "string");
}

function commandToString(...parts: unknown[]): string {
  return parts
    .flatMap((part) => (Array.isArray(part) ? part : part === undefined || part === null ? [] : [part]))
    .map(scalarToString)
    .join(" ");
}

/**
 * Loads one or more compose files. Later files override earlier ones, like
 * `docker compose -f a.yml -f b.yml`. Nothing is written and nothing is fetched.
 */
export function loadCompose(files: string[]): ComposeProject {
  const warnings: string[] = [];
  type Merged = { image?: string; envFiles: string[]; environment: Map<string, string | undefined>; command: string };
  const merged = new Map<string, Merged>();

  const firstDir = dirname(resolve(files[0] ?? "."));
  const dotEnvPath = resolve(firstDir, ".env");
  const dotEnv = existsSync(dotEnvPath) ? parseEnvFile(readFileSync(dotEnvPath, "utf8")) : new Map<string, string | undefined>();
  const vars: Vars = { ...Object.fromEntries(dotEnv), ...process.env };

  for (const file of files) {
    const dir = dirname(resolve(file));
    const doc = parse(readFileSync(file, "utf8"), { merge: true }) as { services?: unknown } | null;
    const services = doc?.services;
    if (typeof services !== "object" || services === null) {
      warnings.push(`${file}: no services found`);
      continue;
    }
    for (const [name, raw] of Object.entries(services as Record<string, unknown>)) {
      const def = (raw ?? {}) as Record<string, unknown>;
      const current: Merged = merged.get(name) ?? { envFiles: [], environment: new Map(), command: "" };
      if (typeof def.image === "string") current.image = interpolate(def.image, vars);
      current.envFiles.push(...envFilePaths(def.env_file).map((p) => resolve(dir, interpolate(p, vars))));
      for (const [k, v] of parseEnvironment(def.environment, vars)) current.environment.set(k, v);
      const command = commandToString(def.entrypoint, def.command);
      if (command !== "") current.command = interpolate(command, vars);
      if (def.extends !== undefined) warnings.push(`${file}: service "${name}" uses extends, which phonehome does not follow`);
      merged.set(name, current);
    }
  }

  const result: ComposeService[] = [];
  for (const [name, svc] of merged) {
    const env = new Map<string, string | undefined>();
    for (const path of svc.envFiles) {
      if (!existsSync(path)) {
        warnings.push(`service "${name}": env_file ${path} not found, its variables were not checked`);
        continue;
      }
      for (const [k, v] of parseEnvFile(readFileSync(path, "utf8"))) env.set(k, v);
    }
    // environment wins over env_file, as in Compose.
    for (const [k, v] of svc.environment) env.set(k, v);
    result.push({ name, ...(svc.image ? { image: svc.image } : {}), env, command: svc.command });
  }
  return { services: result, warnings };
}
