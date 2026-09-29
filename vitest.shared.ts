// Shared Vitest config for every package: env loading, timeouts and v8 coverage over src/.
// Packages set their own coverage thresholds; `pnpm test:coverage` enforces them (and CI runs it).
import { defineConfig } from "vitest/config";

export interface Thresholds {
  lines: number;
  branches: number;
  functions: number;
  statements: number;
}

export function packageConfig(thresholds: Thresholds = { lines: 80, branches: 75, functions: 80, statements: 80 }) {
  return defineConfig({
    test: {
      setupFiles: ["../../vitest.setup.ts"],
      testTimeout: 15000,
      coverage: {
        provider: "v8",
        include: ["src/**/*.{ts,tsx}"],
        exclude: ["src/**/*.d.ts", "src/generated/**", "src/**/index.ts"],
        reporter: ["text-summary", "json-summary"],
        thresholds,
      },
    },
  });
}
