// Code fixer limits (spec 009, decision 10). The ceilings are fixed in code; config can only lower them.
// Pure: no node imports.

export type CodeFixLimits = {
  maxConcurrent: number;
  /** Files changed, the new test included. */
  maxFiles: number;
  /** Added plus removed lines in source files. */
  maxSourceLines: number;
  /** Added plus removed lines in every file, the test included. */
  maxTotalLines: number;
  maxTestLines: number;
  maxEdits: number;
  /** Per author (test author and patch author each). */
  maxAuthorAttempts: number;
  maxLlmCalls: number;
  /** Prompt plus completion tokens. */
  maxTokens: number;
  attemptTimeoutMin: number;
  testTimeoutSec: number;
  maxOutputBytes: number;
  /** Per repository, attempts that entered `running` in the last 24 hours. */
  maxAttemptsPerDay: number;
  maxAttemptsPerGroup: number;
};

export const CODE_FIX_CEILINGS: Readonly<CodeFixLimits> = Object.freeze({
  maxConcurrent: 2,
  maxFiles: 3,
  maxSourceLines: 20,
  maxTotalLines: 50,
  maxTestLines: 40,
  maxEdits: 2,
  maxAuthorAttempts: 3,
  maxLlmCalls: 8,
  maxTokens: 200_000,
  attemptTimeoutMin: 30,
  testTimeoutSec: 600,
  maxOutputBytes: 262_144,
  maxAttemptsPerDay: 20,
  maxAttemptsPerGroup: 5,
});

/** Lowest value config may set (the config schema enforces it; `effectiveLimits` clamps defensively). */
export const CODE_FIX_FLOORS: Readonly<CodeFixLimits> = Object.freeze({
  maxConcurrent: 1,
  maxFiles: 1,
  maxSourceLines: 1,
  maxTotalLines: 1,
  maxTestLines: 1,
  maxEdits: 1,
  maxAuthorAttempts: 1,
  maxLlmCalls: 3,
  maxTokens: 1000,
  attemptTimeoutMin: 1,
  testTimeoutSec: 5,
  maxOutputBytes: 4096,
  maxAttemptsPerDay: 1,
  maxAttemptsPerGroup: 1,
});

export const CODE_FIX_DEFAULT_LIMITS: Readonly<CodeFixLimits> = Object.freeze({
  maxConcurrent: 1,
  maxFiles: 3,
  maxSourceLines: 20,
  maxTotalLines: 50,
  maxTestLines: 40,
  maxEdits: 2,
  maxAuthorAttempts: 2,
  maxLlmCalls: 6,
  maxTokens: 60_000,
  attemptTimeoutMin: 15,
  testTimeoutSec: 120,
  maxOutputBytes: 65_536,
  maxAttemptsPerDay: 5,
  maxAttemptsPerGroup: 3,
});

/** `min(cfg ?? default, ceiling)` per key, never below the floor; a non-finite value uses the default. */
export function effectiveLimits(cfg: Partial<CodeFixLimits> | null | undefined): CodeFixLimits {
  const out = {} as CodeFixLimits;
  for (const key of Object.keys(CODE_FIX_CEILINGS) as (keyof CodeFixLimits)[]) {
    const raw = cfg?.[key];
    const value = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : CODE_FIX_DEFAULT_LIMITS[key];
    out[key] = Math.max(CODE_FIX_FLOORS[key], Math.min(value, CODE_FIX_CEILINGS[key]));
  }
  return out;
}
