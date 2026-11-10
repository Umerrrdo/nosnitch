import type { ComposeService } from "./compose.js";
import { findApp, findMirroredApp, isAtLeastVersion, parseImage } from "./matcher.js";
import type { AppEntry, EnvMethod, EnvPair, TelemetryDefault } from "./types.js";

export const CONTRIBUTING_URL = "https://github.com/Umerrrdo/nosnitch/blob/main/CONTRIBUTING.md";

export type Status =
  /** Telemetry is on by default and no opt-out was detected. */
  | "on"
  | "partial"
  /** In the database, but the default is not documented. */
  | "unknown"
  | "off"
  /** The opt-out is already set in the compose file. */
  | "disabled"
  /** The image tag is at or above the version where the default became off. */
  | "fixed"
  | "not-in-database"
  /** The image name uses a variable that is not set, so it could not be looked up. */
  | "unresolved-image"
  | "no-image";

export interface ServiceResult {
  service: string;
  image: string | null;
  status: Status;
  /** True when nothing needs doing for this service. */
  ok: boolean;
  app: string | null;
  slug: string | null;
  telemetry_default: TelemetryDefault | null;
  verified: boolean | null;
  destinations: string[];
  /** Environment variables to add to turn telemetry off. */
  fix_env: { name: string; value: string }[];
  /** Variables that stop other outbound calls such as update checks. */
  optional_env: { name: string; value: string; note?: string }[];
  /** Steps nosnitch cannot apply for you. */
  manual: string[];
  /** Opt-outs found in the compose file. */
  detected: string[];
  what_is_sent: string | null;
  still_sent: string | null;
  fixed_in: string | null;
  notes: string | null;
  sources: string[];
  /** For an image on a private registry or mirror: the entry it looks like. A hint only. */
  possible_match: string | null;
  /** Things in this service's settings that look like a mistake. */
  problems: string[];
}

function valueMatches(actual: string | undefined, pair: EnvPair): boolean {
  if (actual === undefined) return false;
  // No trimming: a stray space or quote reaches the app as part of the value.
  const have = actual.toLowerCase();
  return [pair.value, ...(pair.accepted_values ?? [])].some((v) => v.toLowerCase() === have);
}

/** Returns the NAME=value that satisfies the method, if the environment has one. */
function satisfiedBy(method: EnvMethod, env: Map<string, string | undefined>): string | undefined {
  for (const pair of [method, ...(method.alternatives ?? [])]) {
    if (valueMatches(env.get(pair.name), pair)) return `${pair.name}=${env.get(pair.name)}`;
  }
  return undefined;
}

function commandHasFlag(command: string, flag: string): boolean {
  return command.split(/\s+/).includes(flag);
}

function manualSteps(app: AppEntry): string[] {
  const steps: string[] = [];
  for (const method of app.disable) {
    if (method.type === "manual") steps.push(method.instructions);
    if (method.type === "config_file") steps.push(`In ${method.path} set ${method.key} to ${method.value}`);
    if (method.type === "flag") steps.push(`Or start it with the flag ${method.flag}`);
  }
  return steps;
}

/** Evaluates an image plus its environment and command against one database entry. */
export function evaluate(
  service: string,
  image: string,
  app: AppEntry,
  env: Map<string, string | undefined>,
  command: string,
): ServiceResult {
  const envMethods = app.disable.filter((m): m is EnvMethod => m.type === "env");
  const required = envMethods.filter((m) => !m.optional);
  const detected: string[] = [];
  const missing: EnvMethod[] = [];

  const problems: string[] = [];
  for (const method of required) {
    const hit = satisfiedBy(method, env);
    if (hit) detected.push(hit);
    else {
      missing.push(method);
      problems.push(...nearMisses(service, method, env));
    }
  }
  for (const method of app.disable) {
    if (method.type === "flag" && commandHasFlag(command, method.flag)) detected.push(method.flag);
  }

  const flagSet = app.disable.some((m) => m.type === "flag" && commandHasFlag(command, m.flag));
  const envSet = required.length > 0 && missing.length === 0;

  let status: Status;
  if (app.telemetry_default === "off") status = "off";
  else if (flagSet || envSet) status = "disabled";
  else if (app.fixed_in && isAtLeastVersion(parseImage(image).tag, app.fixed_in)) status = "fixed";
  else status = app.telemetry_default;

  const needsAction = status === "on" || status === "partial" || status === "unknown";

  return {
    service,
    image,
    status,
    ok: !needsAction,
    app: app.name,
    slug: app.slug,
    telemetry_default: app.telemetry_default,
    verified: app.verified,
    destinations: app.destinations ?? [],
    fix_env: needsAction ? missing.map((m) => ({ name: m.name, value: m.value })) : [],
    optional_env: envMethods
      .filter((m) => m.optional && !satisfiedBy(m, env))
      .map((m) => ({ name: m.name, value: m.value, ...(m.note ? { note: m.note } : {}) })),
    manual: needsAction ? manualSteps(app) : [],
    detected,
    what_is_sent: app.what_is_sent ?? null,
    still_sent: app.still_sent ?? null,
    fixed_in: app.fixed_in ?? null,
    notes: app.notes ?? null,
    sources: app.sources,
    possible_match: null,
    problems,
  };
}

const QUOTED = /^(["'])(.*)\1$/;

/** Explains a value that looks like an opt-out but will not work as one. */
function nearMisses(service: string, method: EnvMethod, env: Map<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const pair of [method, ...(method.alternatives ?? [])]) {
    if (!env.has(pair.name)) continue;
    const actual = env.get(pair.name);
    if (actual === undefined) {
      out.push(`service "${service}": ${pair.name} is passed through from the host without a value, so nosnitch cannot tell if it is set. Give it a value in the compose file.`);
    } else if (valueMatches(actual.trim().replace(QUOTED, "$2").trim(), pair)) {
      out.push(
        `service "${service}": ${pair.name} is set to [${actual}] with extra quote characters or spaces. Compose passes them to the app as part of the value, so it does not count as ${pair.value}. Write it as ${pair.name}=${pair.value}.`,
      );
    }
  }
  return out;
}

function unmatched(
  service: string,
  image: string | null,
  status: Status = image === null ? "no-image" : "not-in-database",
  possible: string | null = null,
): ServiceResult {
  return {
    service,
    image,
    status,
    ok: true,
    app: null,
    slug: null,
    telemetry_default: null,
    verified: null,
    destinations: [],
    fix_env: [],
    optional_env: [],
    manual: [],
    detected: [],
    what_is_sent: null,
    still_sent: null,
    fixed_in: null,
    notes: null,
    sources: [],
    possible_match: possible,
    problems: [],
  };
}

export function scanServices(services: ComposeService[], apps: AppEntry[]): ServiceResult[] {
  return services.map((svc) => {
    if (!svc.image) return unmatched(svc.name, null);
    const app = findApp(svc.image, apps);
    if (!app) {
      // An unset variable in the name part means the real image is not known.
      const nameUnknown = svc.unsetImageVars !== undefined && parseImage(svc.image).name.includes("$");
      if (nameUnknown) return unmatched(svc.name, svc.image, "unresolved-image");
      return unmatched(svc.name, svc.image, "not-in-database", findMirroredApp(svc.image, apps)?.images[0] ?? null);
    }
    return evaluate(svc.name, svc.image, app, svc.env, svc.command);
  });
}

/** Looks up one image with nothing set, as `nosnitch check` does. */
export function checkImage(image: string, apps: AppEntry[]): ServiceResult {
  const app = findApp(image, apps);
  if (!app) return unmatched(image, image, "not-in-database", findMirroredApp(image, apps)?.images[0] ?? null);
  return evaluate(image, image, app, new Map(), "");
}

/**
 * 1 when a verified entry has telemetry on (fully or partly) and no opt-out was
 * found. Unverified and unknown entries are reported but do not fail the run.
 */
export function exitCodeFor(results: ServiceResult[]): 0 | 1 {
  return results.some((r) => (r.status === "on" || r.status === "partial") && r.verified === true) ? 1 : 0;
}
