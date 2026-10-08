// Caminhos a partir da raiz do projeto (independe do diretório atual).
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const projectPath = (...parts: string[]): string => join(PROJECT_ROOT, ...parts);
