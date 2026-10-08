// Logger JSON, uma linha por evento, em stderr, sempre redigido (spec 6.9).
import type { Config } from "../config.ts";
import { redactSecrets } from "./redact.ts";

export type LogFields = Record<string, unknown>;
export type LogLevel = Config["logLevel"];

export interface Logger {
  debug(msg: string, f?: LogFields): void;
  info(msg: string, f?: LogFields): void;
  warn(msg: string, f?: LogFields): void;
  error(msg: string, f?: LogFields): void;
  child(f: LogFields): Logger;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(o: {
  level: LogLevel;
  secrets: readonly string[];
  write?: (line: string) => void;
  now?: () => Date;
}): Logger {
  const write = o.write ?? ((line: string) => void process.stderr.write(line + "\n"));
  const now = o.now ?? (() => new Date());
  const min = ORDER[o.level];

  const make = (bindings: LogFields): Logger => {
    const emit = (level: LogLevel, msg: string, fields?: LogFields) => {
      if (ORDER[level] < min) return;
      const record = { ts: now().toISOString(), level, msg, ...bindings, ...fields };
      write(JSON.stringify(redactSecrets(record, o.secrets)));
    };
    return {
      debug: (msg, f) => emit("debug", msg, f),
      info: (msg, f) => emit("info", msg, f),
      warn: (msg, f) => emit("warn", msg, f),
      error: (msg, f) => emit("error", msg, f),
      child: (f) => make({ ...bindings, ...f }),
    };
  };
  return make({});
}
