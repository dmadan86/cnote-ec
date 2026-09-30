import { defineConfig, devices } from "@playwright/test";
import { DB_READY_PORT, SELLER_PORT, SELLER_URL, WEB_PORT, WEB_URL, e2eEnv } from "./e2e/support/env";

/**
 * UI test suites (see docs/guides/testing.md).
 *
 *   pnpm test:a11y   e2e/a11y        axe-core WCAG 2.2 AA scans + keyboard checks (buyer web, en + hi)
 *   pnpm test:e2e    e2e/functional  buyer + seller user journeys
 *
 * Servers: production builds via `next start` by default (what CI and users get; fast and stable). Build first with
 * `pnpm test:e2e:build`. Set E2E_DEV=1 to use `next dev` instead (no build step, slower first hits, dev overlay).
 * Servers are reused when already running locally (never in CI).
 */
const CI = !!process.env.CI;
const dev = process.env.E2E_DEV === "1";
const serverEnv = { ...e2eEnv, NODE_ENV: dev ? "development" : "production", PORT: "" } as Record<string, string>;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/.results",
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: CI ? [["github"], ["html", { outputFolder: "playwright-report", open: "never" }]] : [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Deterministic locale/timezone; the buyer web is English by default, /hi/... is Hindi.
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testIgnore: /\.mobile\.spec\.ts$/ },
    // Pixel-class viewport (412x915, touch, mobile UA). Only the *.mobile.spec.ts files run here.
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /\.mobile\.spec\.ts$/ },
  ],
  webServer: [
    {
      // 1) Migrate + seed the e2e databases, then hold a port open so Playwright knows the data is ready.
      command: "pnpm exec tsx e2e/setup/prepare-db.ts --serve",
      url: `http://localhost:${DB_READY_PORT}`,
      reuseExistingServer: !CI,
      timeout: 240_000,
      stdout: "pipe",
      env: e2eEnv,
    },
    {
      command: dev ? "pnpm --filter @cnote/web exec next dev -p " + WEB_PORT : `pnpm --filter @cnote/web exec next start -p ${WEB_PORT}`,
      url: WEB_URL,
      reuseExistingServer: !CI,
      timeout: 240_000,
      env: serverEnv,
    },
    {
      command: dev ? "pnpm --filter @cnote/seller-app exec next dev -p " + SELLER_PORT : `pnpm --filter @cnote/seller-app exec next start -p ${SELLER_PORT}`,
      url: `${SELLER_URL}/signin`,
      reuseExistingServer: !CI,
      timeout: 240_000,
      env: serverEnv,
    },
  ],
});
