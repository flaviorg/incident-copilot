// fix_locate (spec 009, decision 5; AC-62, AC-63): the anchor file, line and commit come from connector data only and
// every record is safeParsed. In order: the latest event's exception must be fixable, the error group must be new in a
// deploy of the failing release, the innermost in-app frame must map to an allowlisted path, and the release commit must
// resolve to a 40-hex SHA that the code host confirms. Every failure is a skip reason: nothing was cloned yet.
import * as z from "zod";
import { DeployRecordSchema, ErrorEventSchema, ReleaseCommitSchema } from "../../../contracts/index.ts";
import type { CodeFixReason, DeployRecord, ReleaseCommit } from "../../../contracts/index.ts";
import { isNewInRelease, locateAnchor, resolveCommitCandidate } from "../../../domain/code-fix/frames.ts";
import type { CodeHostReader } from "../../../domain/code-fix/ports.ts";
import { attemptAborted, signalOf } from "../state.ts";
import type { CodeFixNodeFn, CodeFixState, FixConnectorQuery } from "../state.ts";

/** How far back deploys are read; a release deployed earlier fails closed as not new. */
export const DEPLOY_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

export type FixLocateDeps = {
  /** The query capability of a connector id, or null when it has none. */
  query: (connectorId: string) => FixConnectorQuery | null;
  reader: Pick<CodeHostReader, "commitExists">;
  fixableExceptionTypes: readonly string[];
  now: () => Date;
  /** Maps the canonical service to the connector's alias (default: the service itself). */
  serviceAlias?: (connectorId: string, service: string) => string;
};

const DeployListSchema = z.array(z.unknown());

export function createFixLocateNode(d: FixLocateDeps): CodeFixNodeFn {
  return async (state, config) => {
    const fail = (failure: CodeFixReason): Partial<CodeFixState> => ({ stage: "locate", failure });
    if (attemptAborted(config)) return fail("attempt_timeout");
    const repo = state.repository;
    if (repo === null || state.connectorId === null || state.errorGroupId === null) return fail("error_event_unavailable");
    const q = d.query(state.connectorId);
    const service = d.serviceAlias ? d.serviceAlias(state.connectorId, repo.service) : repo.service;
    const io = () => ({ signal: signalOf(config), now: d.now() });

    // 1. The latest event of the error group.
    if (!q?.errorEvent) return fail("error_event_unavailable");
    let rawEvent: unknown;
    try {
      rawEvent = await q.errorEvent({ service, errorId: state.errorGroupId }, io());
    } catch {
      return fail("error_event_unavailable");
    }
    const parsed = ErrorEventSchema.safeParse(rawEvent);
    if (!parsed.success) return fail("error_event_unavailable");
    const event = parsed.data;
    const facts: Partial<CodeFixState> = { exception: event.exception, release: event.release, frames: event.frames };

    // 2. A fixable exception type.
    if (!d.fixableExceptionTypes.includes(event.exception.type)) return { ...facts, ...fail("exception_not_fixable") };

    // 3. New in the failing release (a null release or firstSeen fails closed).
    if (event.release === null || event.firstSeen === null || !q.deploys) return { ...facts, ...fail("not_new_in_release") };
    const since = new Date(Date.parse(state.alertStartedAt) - DEPLOY_LOOKBACK_MS);
    let deploys: DeployRecord[];
    try {
      const raw = DeployListSchema.safeParse(await q.deploys({ service, since }, io()));
      deploys = raw.success ? raw.data.flatMap((x) => { const r = DeployRecordSchema.safeParse(x); return r.success ? [r.data] : []; }) : [];
    } catch {
      deploys = [];
    }
    if (!isNewInRelease(deploys, event.release, event.firstSeen, state.alertStartedAt)) return { ...facts, ...fail("not_new_in_release") };

    // 4. The innermost in-app frame, mapped to a safe allowlisted repo path (no fallback to outer frames).
    const located = locateAnchor(event.frames, repo);
    if (!located.ok) return { ...facts, ...fail(located.reason) };
    const anchor = { ...located.frame, file: located.path };

    // 5. The release commit, confirmed by the code host.
    let releaseCommit: ReleaseCommit | null = null;
    if (q.releaseCommit) {
      try {
        const r = ReleaseCommitSchema.safeParse(await q.releaseCommit({ service, version: event.release }, io()));
        releaseCommit = r.success ? r.data : null;
      } catch {
        releaseCommit = null; // the version may still carry the SHA
      }
    }
    const candidate = resolveCommitCandidate(releaseCommit, event.release, repo.repo);
    if (!candidate.ok) return { ...facts, anchor, ...fail("commit_unresolved") };
    const [owner, name] = repo.repo.split("/") as [string, string];
    let exists = false;
    try {
      exists = await d.reader.commitExists({ owner, repo: name, sha: candidate.sha });
    } catch {
      exists = false;
    }
    if (!exists) return { ...facts, anchor, ...fail("commit_not_found") };

    return { ...facts, anchor, commitSha: candidate.sha, stage: "locate", failure: null };
  };
}
