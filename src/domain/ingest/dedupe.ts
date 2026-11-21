// What a live alert does to its incident (spec 008, decision 8; AC-46 and AC-47). Pure.

export type AlertAction = "open" | "deduplicate" | "resolve" | "ignore_resolved";

/**
 * A firing alert joins an open live incident younger than the window; otherwise it opens a new one (with a stale open
 * incident, the caller closes that live_incidents row first). A resolved alert resolves the open incident, whatever its age.
 */
export function decideAlertAction(i: {
  status: "firing" | "resolved";
  open: { openedAt: string } | null;
  now: Date;
  dedupeWindowMin: number;
}): AlertAction {
  if (i.status === "resolved") return i.open ? "resolve" : "ignore_resolved";
  if (i.open === null) return "open";
  const ageMs = i.now.getTime() - Date.parse(i.open.openedAt);
  return ageMs < i.dedupeWindowMin * 60_000 ? "deduplicate" : "open";
}
