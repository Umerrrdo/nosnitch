import type { AppEntry } from "./types.js";

export interface ImageRef {
  /** Lowercased name with tag, digest and the Docker Hub registry removed. */
  name: string;
  tag?: string;
  digest?: string;
}

const DOCKER_HUB_REGISTRIES = new Set(["docker.io", "index.docker.io", "registry-1.docker.io", "registry.hub.docker.com"]);

/**
 * Splits an image reference into name, tag and digest, and normalises the name
 * so that "docker.io/library/redis:7", "library/redis" and "redis" all compare equal.
 */
export function parseImage(image: string): ImageRef {
  let rest = image.trim();
  let digest: string | undefined;
  let tag: string | undefined;

  const at = rest.indexOf("@");
  if (at !== -1) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }

  // A colon after the last slash is a tag. A colon before it is a registry port.
  const lastSlash = rest.lastIndexOf("/");
  const colon = rest.indexOf(":", lastSlash + 1);
  if (colon !== -1) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }

  const parts = rest.toLowerCase().split("/");
  const first = parts[0] ?? "";
  const hasRegistry = parts.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost");
  if (hasRegistry && DOCKER_HUB_REGISTRIES.has(first)) parts.shift();
  if (parts.length === 2 && parts[0] === "library" && !(hasRegistry && !DOCKER_HUB_REGISTRIES.has(first))) parts.shift();

  return { name: parts.join("/"), ...(tag ? { tag } : {}), ...(digest ? { digest } : {}) };
}

const patternCache = new Map<string, RegExp>();

function patternToRegExp(pattern: string): RegExp {
  const cached = patternCache.get(pattern);
  if (cached) return cached;
  const escaped = parseImage(pattern)
    .name.split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const compiled = new RegExp(`^${escaped}$`);
  patternCache.set(pattern, compiled);
  return compiled;
}

/**
 * For an image on a private registry or mirror: the entry it would match if the
 * registry host were removed. Used only to print a hint, never to decide a status.
 */
export function findMirroredApp(image: string, apps: AppEntry[]): AppEntry | undefined {
  const parts = parseImage(image).name.split("/");
  const first = parts[0] ?? "";
  if (parts.length < 2 || !(first.includes(".") || first.includes(":") || first === "localhost")) return undefined;
  const rest = parts.slice(1);
  return findApp(rest.join("/"), apps) ?? (rest.length > 1 ? findApp(rest.slice(1).join("/"), apps) : undefined);
}

export function matchesPattern(image: string, pattern: string): boolean {
  return patternToRegExp(pattern).test(parseImage(image).name);
}

/** Finds the database entry for an image. Exact name matches only: no guessing. */
export function findApp(image: string, apps: AppEntry[]): AppEntry | undefined {
  return apps.find((app) => app.images.some((pattern) => matchesPattern(image, pattern)));
}

/** Reads "1.2.3", "v1.2.3" or "1.2.3-suffix" into numbers. Returns undefined for tags like "latest". */
export function parseVersion(tag: string | undefined): [number, number, number] | undefined {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+_].*)?$/.exec(tag ?? "");
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/**
 * True when the tag is provably at or above fixedIn. A partial tag such as "3"
 * or "3.3" moves over time and may still point at an old pull, so it only
 * counts when every release it could point to is already fixed.
 */
export function isAtLeastVersion(tag: string | undefined, fixedIn: string): boolean {
  const fixed = parseVersion(fixedIn);
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+_].*)?$/.exec(tag ?? "");
  if (!fixed || !m) return false;
  const have = [Number(m[1]), m[2] === undefined ? undefined : Number(m[2]), m[3] === undefined ? undefined : Number(m[3])];
  for (let i = 0; i < 3; i++) {
    const h = have[i];
    const f = fixed[i] ?? 0;
    if (h === undefined) return false;
    if (h > f) return true;
    if (h < f) return false;
  }
  return true;
}
