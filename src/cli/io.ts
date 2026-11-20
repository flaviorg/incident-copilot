// CLI input and output: everything that goes to stdout and stderr passes through redactSecrets.
export type CliIO = {
  env: Record<string, string | undefined>;
  out(text: string): void;
  err(text: string): void;
  /** Adds secrets resolved by a command (copilot.yaml) to the redaction list of `out` and `err`. */
  addSecrets?(secrets: readonly string[]): void;
};

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
