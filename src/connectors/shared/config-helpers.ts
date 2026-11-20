// Field builders for connector and notifier config schemas (spec 008, decision 12; AC-51 and AC-52). Every issue
// message is our own fixed text and names at most an environment variable, never a value.
import * as z from "zod";

export interface ConfigHelpers {
  /** A string with every ${NAME} interpolated from the environment; an unset variable is an issue. */
  text(o?: { min?: number; max?: number }): z.ZodType<string>;
  /** Only a whole "${NAME}" naming a set variable of at least `min` characters (default 16); the value joins the redaction list. */
  secret(o?: { min?: number }): z.ZodType<string>;
  /** An interpolated https URL (http only for localhost, 127.0.0.1 and [::1] when allowLoopbackHttp, default true), without credentials. */
  url(o?: { allowLoopbackHttp?: boolean }): z.ZodType<string>;
}

export const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const REFERENCE = /\$\{([^}]*)\}/g;
const WHOLE_REFERENCE = /^\$\{([A-Z][A-Z0-9_]*)\}$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const SECRET_MIN_LENGTH = 16;
export const SECRET_RULE = "secrets must be a whole ${VAR} reference";
export const unsetRule = (name: string) => `environment variable ${name} is not set`;

const isSet = (v: string | undefined): v is string => typeof v === "string" && v.trim() !== "";

export function createConfigHelpers(env: Readonly<Record<string, string | undefined>>, secretSink: string[]): ConfigHelpers {
  const interpolated = z.string().transform((s, ctx) => {
    let failed = false;
    const out = s.replace(REFERENCE, (whole, name: string) => {
      if (!ENV_NAME.test(name)) return whole;
      const v = env[name];
      if (!isSet(v)) {
        ctx.addIssue({ code: "custom", message: unsetRule(name) });
        failed = true;
        return "";
      }
      return v;
    });
    return failed ? z.NEVER : out;
  });

  const text = (o: { min?: number; max?: number } = {}) => interpolated.pipe(z.string().min(o.min ?? 1).max(o.max ?? 1000));

  const secret = (o: { min?: number } = {}) =>
    z.string().transform((s, ctx) => {
      const m = WHOLE_REFERENCE.exec(s.trim());
      if (!m) {
        ctx.addIssue({ code: "custom", message: SECRET_RULE });
        return z.NEVER;
      }
      const name = m[1]!;
      const v = env[name];
      if (!isSet(v)) {
        ctx.addIssue({ code: "custom", message: unsetRule(name) });
        return z.NEVER;
      }
      const min = o.min ?? SECRET_MIN_LENGTH;
      if (v.length < min) {
        ctx.addIssue({ code: "custom", message: `environment variable ${name} must hold at least ${min} characters` });
        return z.NEVER;
      }
      secretSink.push(v);
      return v;
    });

  const url = (o: { allowLoopbackHttp?: boolean } = {}) =>
    text({ max: 2000 }).pipe(
      z.string().transform((s, ctx) => {
        let u: URL;
        try {
          u = new URL(s);
        } catch {
          ctx.addIssue({ code: "custom", message: "must be a URL" });
          return z.NEVER;
        }
        if (u.username !== "" || u.password !== "") {
          ctx.addIssue({ code: "custom", message: "URLs must not carry credentials" });
          return z.NEVER;
        }
        const loopbackHttp = (o.allowLoopbackHttp ?? true) && u.protocol === "http:" && LOOPBACK.has(u.hostname);
        if (u.protocol !== "https:" && !loopbackHttp) {
          ctx.addIssue({ code: "custom", message: "must be an https URL (http only for loopback hosts)" });
          return z.NEVER;
        }
        return s;
      }),
    );

  return { text, secret, url };
}
