// Entrada e saída da CLI: tudo que vai para stdout e stderr passa por redactSecrets.
export type CliIO = {
  env: Record<string, string | undefined>;
  out(text: string): void;
  err(text: string): void;
};

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
