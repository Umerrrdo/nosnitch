import type { ServiceResult } from "./scanner.js";

export const BLOCKLIST_FORMATS = ["hosts", "pihole", "adguard"] as const;
export type BlocklistFormat = (typeof BLOCKLIST_FORMATS)[number];

export function isBlocklistFormat(value: string): value is BlocklistFormat {
  return (BLOCKLIST_FORMATS as readonly string[]).includes(value);
}

/**
 * Destinations of every matched app in the compose file, whether or not the
 * app is already opted out. Only documented destinations are in the database.
 */
export function collectDestinations(results: ServiceResult[]): Map<string, string[]> {
  const byHost = new Map<string, string[]>();
  for (const r of results) {
    for (const host of r.destinations) {
      const apps = byHost.get(host) ?? [];
      if (r.app && !apps.includes(r.app)) apps.push(r.app);
      byHost.set(host, apps);
    }
  }
  return new Map([...byHost].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * hosts:   0.0.0.0 example.com      (/etc/hosts, also accepted by Pi-hole and AdGuard Home)
 * pihole:  example.com              (plain domain list)
 * adguard: ||example.com^           (adblock-style rule, also accepted by Pi-hole)
 */
export function renderBlocklist(results: ServiceResult[], format: BlocklistFormat = "hosts"): string {
  const comment = format === "adguard" ? "!" : "#";
  const hosts = collectDestinations(results);
  const lines = [`${comment} nosnitch blocklist (${format}): documented telemetry destinations for the apps in your compose file`];
  if (hosts.size === 0) lines.push(`${comment} No documented destinations for these apps.`);
  for (const [host, apps] of hosts) {
    lines.push(`${comment} ${apps.join(", ")}`);
    if (format === "hosts") lines.push(`0.0.0.0 ${host}`);
    else if (format === "pihole") lines.push(host);
    else lines.push(`||${host}^`);
  }
  return lines.join("\n");
}
