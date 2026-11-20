// Pure renderer of a notification into Slack's incoming-webhook body (spec 008, AC-56; docs/connectors/slack.md).
// Every text that comes from the message is escaped ("&", "<", ">") so it can neither mention a channel nor open a
// link, and clipped to Slack's limits (section text 3000 characters, each field 2000) without cutting an escape in half.
import type { NotificationKind, NotificationMessage } from "../types.ts";

export type SlackText = { type: "mrkdwn"; text: string };
export type SlackBlock =
  | { type: "section"; text?: SlackText; fields?: SlackText[] }
  | { type: "context"; elements: SlackText[] };
export type SlackMessage = { text: string; blocks: SlackBlock[] };

/** Slack limits (section-block reference): section text 1..3000, at most 10 fields of at most 2000. */
export const SECTION_MAX = 3000;
export const FIELD_MAX = 2000;
export const MAX_FIELDS = 10;
/** Recommendation lines shown before "(N more)". */
export const MAX_RECOMMENDATIONS = 10;
const HYPOTHESIS_MAX = 1500;
const MAX_URL = 1000;

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const escapeChar = (c: string) => ESCAPES[c] ?? c;

/** One line, escaped for Slack mrkdwn and at most `max` characters long, ending in an ellipsis when it was clipped. */
export function clipEscaped(raw: string, max: number): string {
  const line = raw.replace(/\s+/g, " ").trim();
  let out = "";
  let used = 0;
  const chars = Array.from(line);
  for (let i = 0; i < chars.length; i++) {
    const piece = escapeChar(chars[i]!);
    const remaining = chars.length - i - 1;
    // Keep one character of room for the ellipsis unless this is the last character and it fits.
    if (used + piece.length + (remaining > 0 ? 1 : 0) > max) return out + "…";
    out += piece;
    used += piece.length;
  }
  return out;
}

const orDash = (s: string) => (s === "" ? "-" : s);

/** A http(s) URL for a `<url|label>` link, or null. `|`, `<` and `>` are removed and `&` escaped, as Slack expects. */
export function slackUrl(raw: string | null): string | null {
  if (raw === null) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const cleaned = raw.trim().replace(/[|<>\s]/g, "");
  let again: URL;
  try {
    again = new URL(cleaned);
  } catch {
    return null;
  }
  if (again.protocol !== u.protocol) return null;
  if (cleaned.length > MAX_URL) return null; // a link this long would push the section over its limit
  return cleaned.replace(/&/g, "&amp;");
}

const link = (url: string | null, label: string): string | null => {
  const href = slackUrl(url);
  return href === null ? null : `<${href}|${clipEscaped(label, 100)}>`;
};

const KIND_TEXT: Record<NotificationKind, string> = {
  incident_opened: "Incident opened",
  analysis_ready: "Analysis ready",
  run_failed: "Run failed",
  incident_resolved: "Resolved",
};

function recommendationLine(r: NotificationMessage["recommendations"][number]): string {
  const head = `Tier ${r.tier} - ${clipEscaped(r.actionType, 60)} on ${clipEscaped(r.target, 120)} - `;
  if (r.tier === 4 || r.status === "blocked_forbidden") return head + "blocked (forbidden by construction)";
  if (r.status === "blocked_unknown") return head + "blocked (not in the catalog)";
  if (r.status.startsWith("blocked")) return head + "blocked";
  if (r.tier === 3) return head + "recommended, not executed (would require human approval)";
  return head + "recommended, not executed (shadow mode)";
}

const section = (text: string): SlackBlock => ({ type: "section", text: { type: "mrkdwn", text: text.slice(0, SECTION_MAX) } });

export function renderSlack(m: NotificationMessage): SlackMessage {
  const title = orDash(clipEscaped(m.title, 2000));
  const sev = m.severity.toUpperCase();
  const fallback = `[${sev}] ${KIND_TEXT[m.kind]}: ${title}${m.service === null ? "" : ` (${clipEscaped(m.service, 200)})`}`;

  const blocks: SlackBlock[] = [];
  blocks.push(section(`*${title}*\n${clipEscaped(m.incidentId, 100)} - ${clipEscaped(m.status, 100)}`));

  const source = m.source.connectorId === "" ? clipEscaped(m.source.type, 200) : `${clipEscaped(m.source.connectorId, 100)} (${clipEscaped(m.source.type, 100)})`;
  const fields = [
    `*Severity*\n${sev}`,
    `*Service*\n${m.service === null ? "unknown" : orDash(clipEscaped(m.service, 500))}`,
    `*Source*\n${orDash(source)}`,
    `*Status*\n${orDash(clipEscaped(m.status, 500))}`,
  ];
  blocks.push({ type: "section", fields: fields.slice(0, MAX_FIELDS).map((text) => ({ type: "mrkdwn" as const, text: text.slice(0, FIELD_MAX) })) });

  if (m.diagnosis) {
    const d = m.diagnosis;
    blocks.push(section(`*Diagnosis*\nCategory: ${clipEscaped(d.category, 100)} | Confidence: ${clipEscaped(d.confidence, 100)}\n${clipEscaped(d.hypothesis, HYPOTHESIS_MAX)}`));
  }

  if (m.recommendations.length > 0) {
    const sorted = [...m.recommendations].sort((a, b) => a.order - b.order);
    const lines = sorted.slice(0, MAX_RECOMMENDATIONS).map(recommendationLine);
    if (sorted.length > MAX_RECOMMENDATIONS) lines.push(`(${sorted.length - MAX_RECOMMENDATIONS} more)`);
    blocks.push(section(`*Recommendations*\n${lines.join("\n")}`));
  }

  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "Shadow mode: nothing was executed." }] });

  const links = [link(m.links.incident, "Open incident"), link(m.source.url, m.source.connectorId === "" ? "Source alert" : `Source alert (${m.source.connectorId})`)].filter((l): l is string => l !== null);
  if (links.length > 0) blocks.push(section(links.join(" | ")));

  return { text: fallback.slice(0, SECTION_MAX), blocks };
}
