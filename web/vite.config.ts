// War Room (spec 4.8 e 10.2): base do Pages por VITE_BASE, aliases para contracts e domain do backend (código puro,
// seguro para navegador), uma só cópia do zod e a configuração do Vitest (jsdom).
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
