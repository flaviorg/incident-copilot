// Versão da aplicação lida do package.json (usada por /health e pelo servidor MCP).
import { readFileSync } from "node:fs";
import { projectPath } from "./paths.ts";

const pkg = JSON.parse(readFileSync(projectPath("package.json"), "utf8")) as { version: string };

export const APP_VERSION: string = pkg.version;
