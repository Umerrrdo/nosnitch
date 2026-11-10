import { CONTRIBUTING_URL, type ServiceResult } from "./scanner.js";
import type { AppEntry } from "./types.js";

/** Plain text table. Cells may contain newlines. */
export function table(headers: string[], rows: string[][]): string {
  const split = rows.map((row) => row.map((cell) => cell.split("\n")));
  const widths = headers.map((h, i) => Math.max(h.length, ...split.flatMap((row) => (row[i] ?? [""]).map((line) => line.length))));
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  const out = [line(headers), line(widths.map((w) => "-".repeat(w)))];
  for (const row of split) {
    const height = Math.max(...row.map((cell) => cell.length));
    for (let n = 0; n < height; n++) out.push(line(row.map((cell) => cell[n] ?? "")));
  }
  return out.join("\n");
}

function shorten(text: string, max = 70): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function defaultCell(r: ServiceResult): string {
  if (r.telemetry_default === null) return "-";
  return r.verified ? r.telemetry_default : `${r.telemetry_default} (unverified)`;
}

function fixCell(r: ServiceResult): string {
  switch (r.status) {
    case "not-in-database":
      return "not in database";
    case "no-image":
      return "no image (built locally)";
    case "off":
      return "OK: off by default";
    case "disabled":
      return `OK: ${r.detected.join(", ")}`;
    case "fixed":
      return `OK: fixed in ${r.fixed_in}`;
    default: {
      const lines = r.fix_env.map((e) => `set ${e.name}=${e.value}`);
      if (lines.length === 0) lines.push(...r.manual.map((m) => `manual: ${shorten(m)}`));
      if (lines.length === 0) lines.push("no documented opt-out");
      return lines.join("\n");
    }
  }
}

export function renderScan(results: ServiceResult[], warnings: string[]): string {
  const out: string[] = [];
  out.push(
    table(
      ["SERVICE", "IMAGE", "TELEMETRY DEFAULT", "DESTINATIONS", "FIX"],
      results.map((r) => [r.service, r.image ?? "-", defaultCell(r), r.destinations.join("\n") || "-", fixCell(r)]),
    ),
  );

  const failing = results.filter((r) => (r.status === "on" || r.status === "partial") && r.verified);
  const unsure = results.filter((r) => !r.ok && !failing.includes(r));
  const residual = results.filter((r) => r.status === "disabled" && r.still_sent);
  const unknownImages = results.filter((r) => r.status === "not-in-database");

  out.push("");
  if (failing.length > 0) {
    out.push(`${failing.length} service(s) send telemetry by default and are not opted out: ${failing.map((r) => r.service).join(", ")}`);
  } else {
    out.push("No known telemetry left on.");
  }
  if (unsure.length > 0) {
    out.push(`Not confirmed (unverified entry or undocumented default): ${unsure.map((r) => r.service).join(", ")}`);
  }
  for (const r of residual) out.push(`${r.service}: still sent after opting out: ${r.still_sent}`);
  if (unknownImages.length > 0) {
    out.push(`Not in database: ${unknownImages.map((r) => r.image).join(", ")}`);
    out.push(`  Know how one of these behaves? Add it: ${CONTRIBUTING_URL}`);
  }
  for (const w of warnings) out.push(`warning: ${w}`);
  return out.join("\n");
}

export function renderCheck(r: ServiceResult): string {
  if (r.status === "not-in-database") {
    return `${r.image}: not in database.\nphonehome does not guess. Add it: ${CONTRIBUTING_URL}`;
  }
  const out: string[] = [];
  out.push(`${r.app} (${r.image})`);
  out.push(`  telemetry default: ${defaultCell(r)}`);
  if (r.status === "fixed") out.push(`  this tag is at or above ${r.fixed_in}, where the default became off`);
  else if (r.fixed_in) out.push(`  default became off in: ${r.fixed_in}`);
  if (r.what_is_sent) out.push(`  what is sent: ${r.what_is_sent}`);
  out.push(`  destinations: ${r.destinations.join(", ") || "not documented"}`);
  for (const e of r.fix_env) out.push(`  disable: set ${e.name}=${e.value}`);
  for (const m of r.manual) out.push(`  disable: ${m}`);
  for (const e of r.optional_env) out.push(`  other outbound calls: set ${e.name}=${e.value}${e.note ? ` (${e.note})` : ""}`);
  if (r.still_sent) out.push(`  still sent after opting out: ${r.still_sent}`);
  if (r.notes) out.push(`  notes: ${r.notes}`);
  for (const s of r.sources) out.push(`  source: ${s}`);
  return out.join("\n");
}

export function renderList(apps: AppEntry[]): string {
  const rows = [...apps]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((a) => [a.slug, a.name, a.telemetry_default, a.verified ? "yes" : "no", a.images.join("\n")]);
  return `${table(["SLUG", "NAME", "DEFAULT", "VERIFIED", "IMAGES"], rows)}\n\n${apps.length} apps, ${apps.filter((a) => a.verified).length} verified.`;
}
