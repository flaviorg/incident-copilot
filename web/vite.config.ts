// War Room (spec 4.8 and 10.2): Pages base set by VITE_BASE, aliases for the backend's contracts and domain (pure code,
// browser-safe), a single copy of zod, and the Vitest (jsdom) configuration.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  plugins: [react()],
  resolve: {
    alias: {
      "@contracts": fileURLToPath(new URL("../src/contracts/index.ts", import.meta.url)),
      "@domain": fileURLToPath(new URL("../src/domain", import.meta.url)),
    },
    dedupe: ["zod"],
  },
  server: { fs: { allow: [".."] } },
  test: { environment: "jsdom", css: true, setupFiles: ["./src/test/setup.ts"], include: ["src/test/**/*.test.{ts,tsx}"] },
});
