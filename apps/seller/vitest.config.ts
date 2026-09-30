import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Seller app unit tests (i18n catalogues, pure helpers). Rendering runs with react-dom/server; no browser.
export default defineConfig({
  resolve: { alias: { "@": at("./src"), "server-only": at("./test/empty.ts") } },
  test: { environment: "node", include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"], testTimeout: 15000 },
});
