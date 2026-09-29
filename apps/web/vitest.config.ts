import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Component/a11y/SEO contract tests render with react-dom/server (no browser, no new dependencies).
export default defineConfig({
  resolve: { alias: { "@": at("./src"), "server-only": at("./test/empty.ts") } },
  test: { environment: "node", include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"], testTimeout: 15000 },
});
