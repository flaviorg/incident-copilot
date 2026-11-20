// Sentry REST client for the investigation tools (docs/connectors/sentry.md): unresolved issues of a project become
// ErrorGroups, releases become DeployRecords. Read-only GETs with the integration's Bearer token. The URL builders are
// isolated at the top because the issue list endpoint and the project detail endpoint are unverified.
import { DeployRecordSchema, ErrorGroupSchema } from "../../contracts/index.ts";
import type { DeployRecord, ErrorGroup } from "../../contracts/index.ts";
import { ConnectorError } from "../shared/errors.ts";
import type { HttpClient } from "../shared/http.ts";
import { MAX_RETRY_AFTER_SEC, parseRetryAfter } from "../shared/http.ts";
import { asRecord, asString, httpUrlOrNull, toIsoOrNull } from "../shared/parse-utils.ts";
import type { QueryCapability, QueryIO } from "../types.ts";
import type { SentryConfig } from "./config.ts";

type QueryConfig = NonNullable<SentryConfig["query"]>;

const SLUG = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const STATS_PERIOD = "24h";
const RELEASES_PER_PAGE = 10;
const RELEASES_PER_PAGE_UNFILTERED = 100;

// ---- URL builders (UNVERIFIED endpoints: fix here only) ---------------------------------------------------------

const apiBase = (c: QueryConfig) => `${c.baseUrl.replace(/\/+$/, "")}/api/0`;
const orgPath = (c: QueryConfig) => `${apiBase(c)}/organizations/${encodeURIComponent(c.organization)}`;

/** Unresolved issues of a project (unverified: GET /api/0/projects/{org}/{project}/issues/). */
export function projectIssuesUrl(c: QueryConfig, slug: string): string {
  const q = new URLSearchParams({ query: "is:unresolved", statsPeriod: STATS_PERIOD });
  if (c.environment) q.set("environment", c.environment);
  return `${apiBase(c)}/projects/${encodeURIComponent(c.organization)}/${encodeURIComponent(slug)}/issues/?${q}`;
}

/** Project detail, for its numeric id (unverified: GET /api/0/projects/{org}/{project}/). */
export function projectUrl(c: QueryConfig, slug: string): string {
  return `${apiBase(c)}/projects/${encodeURIComponent(c.organization)}/${encodeURIComponent(slug)}/`;
}

/** Organization releases (documented), filtered by numeric project id when known (unverified: id accepted by `project`). */
export function releasesUrl(c: QueryConfig, projectId: string | null): string {
  const q = new URLSearchParams();
  if (projectId !== null) q.set("project", projectId);
  q.set("per_page", String(projectId !== null ? RELEASES_PER_PAGE : RELEASES_PER_PAGE_UNFILTERED));
  if (c.environment) q.set("environment", c.environment);
  return `${orgPath(c)}/releases/?${q}`;
}

// ---- mapping --------------------------------------------------------------------------------------------------------

const nonNegativeInt = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
};

function toErrorGroup(raw: unknown): ErrorGroup | null {
  const i = asRecord(raw);
  const id = asString(i?.id, 200);
  if (!i || !id) return null;
  const parsed = ErrorGroupSchema.safeParse({
    id,
    title: asString(i.title, 300) ?? "Untitled issue",
    culprit: asString(i.culprit, 300),
    level: asString(i.level, 40),
    status: asString(i.status, 40),
    count: nonNegativeInt(i.count),
    userCount: nonNegativeInt(i.userCount),
    firstSeen: toIsoOrNull(i.firstSeen),
    lastSeen: toIsoOrNull(i.lastSeen),
    release: asString(asRecord(i.lastRelease)?.version, 120),
    url: httpUrlOrNull(i.permalink),
  });
  return parsed.success ? parsed.data : null;
}

/** Slugs a release lists; null when it lists none we can read (then the release is kept). */
function releaseSlugs(r: Record<string, unknown>): string[] | null {
  if (!Array.isArray(r.projects)) return null;
  const slugs = r.projects
    .map((p) => (typeof p === "string" ? p : asRecord(p) && typeof asRecord(p)!.slug === "string" ? (asRecord(p)!.slug as string) : null))
    .filter((s): s is string => s !== null);
  return slugs.length > 0 ? slugs : null;
}

function toDeploy(raw: unknown, slug: string, since: Date): DeployRecord | null {
  const r = asRecord(raw);
  const version = asString(r?.version, 120);
  if (!r || !version) return null;
  const slugs = releaseSlugs(r);
  if (slugs !== null && !slugs.includes(slug)) return null;
  const deploy = asRecord(r.lastDeploy);
  const at = toIsoOrNull(deploy?.dateFinished) ?? toIsoOrNull(r.dateReleased) ?? toIsoOrNull(r.dateCreated);
  if (at === null || Date.parse(at) < since.getTime()) return null;
  const parsed = DeployRecordSchema.safeParse({ version, at, environment: asString(deploy?.environment, 120), author: null, description: null, url: null });
  return parsed.success ? parsed.data : null;
}

// ---- transport --------------------------------------------------------------------------------------------------

/** Seconds until the epoch in X-Sentry-Rate-Limit-Reset, never negative, capped at one hour; null when unreadable. */
function resetWaitSec(header: string | null, nowMs: number): number | null {
  if (header === null || !/^\d+(\.\d+)?$/.test(header.trim())) return null;
  return Math.min(MAX_RETRY_AFTER_SEC, Math.max(0, Math.ceil(Number(header) - nowMs / 1000)));
}

export function createSentryQuery(config: QueryConfig, http: HttpClient): QueryCapability {
  const projectIds = new Map<string, string>();

  /** GET as JSON through `http.request`, so a 429 without Retry-After can use Sentry's rate-limit reset header. */
  async function getJson(url: string, io: QueryIO): Promise<unknown> {
    const res = await http.request({ method: "GET", url, headers: { authorization: `Bearer ${config.token}`, accept: "application/json" }, signal: io.signal });
    if (res.status === 401 || res.status === 403) throw new ConnectorError("auth");
    if (res.status === 429) {
      const nowMs = io.now.getTime();
      const retryAfterSec = parseRetryAfter(res.headers.get("retry-after"), nowMs) ?? resetWaitSec(res.headers.get("x-sentry-rate-limit-reset"), nowMs);
      throw new ConnectorError("rate_limited", { retryAfterSec });
    }
    if (res.status >= 500) throw new ConnectorError("unavailable");
    if (res.status < 200 || res.status >= 300) throw new ConnectorError("bad_response");
    try {
      return JSON.parse(res.text) as unknown;
    } catch {
      throw new ConnectorError("bad_response");
    }
  }

  const checkSlug = (service: string): string => {
    if (!SLUG.test(service)) throw new ConnectorError("unsafe_input");
    return service;
  };

  /** The numeric project id, cached on success. A missing or unreadable project (bad_response) gives null; auth, rate limits and outages propagate. */
  async function projectId(slug: string, io: QueryIO): Promise<string | null> {
    const cached = projectIds.get(slug);
    if (cached !== undefined) return cached;
    try {
      const id = asRecord(await getJson(projectUrl(config, slug), io))?.id;
      const text = typeof id === "number" && Number.isInteger(id) ? String(id) : typeof id === "string" && /^\d{1,20}$/.test(id) ? id : null;
      if (text !== null) projectIds.set(slug, text);
      return text;
    } catch (e) {
      if (e instanceof ConnectorError && e.kind === "bad_response") return null;
      throw e;
    }
  }

  return {
    async errors(q, io) {
      const slug = checkSlug(q.service);
      const body = await getJson(projectIssuesUrl(config, slug), io);
      if (!Array.isArray(body)) throw new ConnectorError("bad_response");
      const groups: ErrorGroup[] = [];
      for (const raw of body) {
        if (groups.length >= q.limit) break;
        const g = toErrorGroup(raw);
        if (g) groups.push(g);
      }
      return groups;
    },

    async deploys(q, io) {
      const slug = checkSlug(q.service);
      const id = await projectId(slug, io);
      const body = await getJson(releasesUrl(config, id), io);
      if (!Array.isArray(body)) throw new ConnectorError("bad_response");
      return body
        .map((r) => toDeploy(r, slug, q.since))
        .filter((d): d is DeployRecord => d !== null)
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    },
  };
}
