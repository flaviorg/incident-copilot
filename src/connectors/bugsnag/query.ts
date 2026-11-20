// Bugsnag Data Access API v2 (read-only): the errors of a project and its releases, as normalized telemetry records.
// The endpoint paths, query parameters and snake_case response fields are inferred from secondary sources and not
// confirmed by the documentation (docs/connectors/bugsnag.md, "Unverified"), so the URL builders are in one function and
// every field is read defensively. Failures surface as ConnectorError only (the shared HttpClient throws them).
import { DeployRecordSchema, ErrorGroupSchema } from "../../contracts/index.ts";
import type { DeployRecord, ErrorGroup } from "../../contracts/index.ts";
import { asRecord, asString, toIsoOrNull } from "../shared/parse-utils.ts";
import { ConnectorError } from "../shared/errors.ts";
import type { HttpClient } from "../shared/http.ts";
import type { QueryCapability } from "../types.ts";
import type { BugsnagConfig } from "./config.ts";

const MAX_PER_PAGE = 100;
const RELEASES_PER_PAGE = 10;

/** The only place that knows Bugsnag URLs. Fix a path or a parameter here. */
export function bugsnagUrls(baseUrl: string) {
  const base = baseUrl.replace(/\/+$/, "");
  const project = (id: string) => `${base}/projects/${encodeURIComponent(id)}`;
  return {
    errors: (projectId: string, limit: number) =>
      `${project(projectId)}/errors?sort=last_seen&direction=desc&per_page=${Math.min(MAX_PER_PAGE, Math.max(1, Math.trunc(limit)))}`,
    releases: (projectId: string) => `${project(projectId)}/releases?per_page=${RELEASES_PER_PAGE}`,
  };
}

/** First of the given keys (snake_case first, then camelCase) that is present on the record. */
const pick = (r: Record<string, unknown>, ...keys: string[]): unknown => keys.map((k) => r[k]).find((v) => v !== undefined && v !== null);

const countOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

export function mapBugsnagError(raw: unknown): ErrorGroup | null {
  const r = asRecord(raw);
  if (!r) return null;
  const id = asString(r.id, 200);
  if (!id) return null;
  const cls = asString(pick(r, "error_class", "errorClass"), 200);
  const message = asString(r.message, 300);
  const title = cls && message ? asString(`${cls}: ${message}`, 300) : (cls ?? message);
  const parsed = ErrorGroupSchema.safeParse({
    id,
    title: title ?? "Bugsnag error",
    culprit: asString(r.context, 300),
    level: asString(r.severity, 40),
    status: asString(r.status, 40),
    count: countOrNull(pick(r, "events", "events_count", "eventsCount")),
    userCount: countOrNull(pick(r, "users", "users_count", "usersCount")),
    firstSeen: toIsoOrNull(pick(r, "first_seen", "firstSeen")),
    lastSeen: toIsoOrNull(pick(r, "last_seen", "lastSeen")),
    release: null,
    url: null,
  });
  return parsed.success ? parsed.data : null;
}

export function mapBugsnagRelease(raw: unknown): DeployRecord | null {
  const r = asRecord(raw);
  if (!r) return null;
  const version = asString(pick(r, "app_version", "appVersion", "version"), 120);
  const at = toIsoOrNull(pick(r, "release_time", "released_at", "releaseTime", "releasedAt"));
  if (!version || !at) return null;
  const stage = pick(r, "release_stage", "releaseStage");
  const parsed = DeployRecordSchema.safeParse({
    version,
    at,
    environment: asString(asRecord(stage)?.name ?? stage, 120),
    author: null,
    description: null,
    url: null,
  });
  return parsed.success ? parsed.data : null;
}

export function createBugsnagQuery(query: NonNullable<BugsnagConfig["query"]>, http: HttpClient): QueryCapability {
  const urls = bugsnagUrls(query.baseUrl);
  const projects = Object.entries(query.projects);
  /** The alias of the service is the Bugsnag project name; an unknown service has no data here, which is not an error. */
  const projectIdFor = (service: string): string | null => {
    const wanted = service.trim().toLowerCase();
    return projects.find(([alias]) => alias.trim().toLowerCase() === wanted)?.[1] ?? null;
  };
  const headers = { authorization: `token ${query.token}`, "x-version": "2", accept: "application/json" };
  const list = async (url: string, signal: AbortSignal): Promise<unknown[]> => {
    const body = await http.json<unknown>({ method: "GET", url, headers, signal });
    if (!Array.isArray(body)) throw new ConnectorError("bad_response");
    return body;
  };

  return {
    async errors({ service, limit }, io) {
      const id = projectIdFor(service);
      if (id === null) return [];
      const rows = await list(urls.errors(id, limit), io.signal);
      return rows.map(mapBugsnagError).filter((g): g is ErrorGroup => g !== null).slice(0, Math.max(0, limit));
    },
    async deploys({ service, since }, io) {
      const id = projectIdFor(service);
      if (id === null) return [];
      const rows = await list(urls.releases(id), io.signal);
      return rows
        .map(mapBugsnagRelease)
        .filter((d): d is DeployRecord => d !== null && Date.parse(d.at) >= since.getTime())
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    },
  };
}
