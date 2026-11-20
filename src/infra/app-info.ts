// Application version read from package.json (used by /health and the MCP server).
import { readFileSync } from "node:fs";
import { projectPath } from "./paths.ts";

const pkg = JSON.parse(readFileSync(projectPath("package.json"), "utf8")) as { version: string };

export const APP_VERSION: string = pkg.version;
