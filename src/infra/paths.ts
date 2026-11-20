// Paths from the project root (independent of the current directory).
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const projectPath = (...parts: string[]): string => join(PROJECT_ROOT, ...parts);
