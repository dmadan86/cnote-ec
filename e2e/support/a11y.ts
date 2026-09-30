import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type TestInfo } from "@playwright/test";
type Result = Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"][number];

/** WCAG 2.2 AA (CLAUDE.md: "Accessibility is a release blocker for the buyer web"). */
export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const BLOCKING = new Set(["serious", "critical"]);

export interface ScanOptions {
  /** Axe rule ids to leave out of the blocking scan because of a tracked bug (pair with a `test.fixme` that asserts the rule). */
  knownRules?: string[];
  /** CSS selectors to exclude (third-party widgets only; never to hide our own violations). */
  exclude?: string[];
}

const fmt = (v: Result) =>
  `${v.id} [${v.impact}] ${v.help}\n${v.nodes
    .slice(0, 5)
    .map((n) => `    ${n.target.join(" ")}\n      ${n.failureSummary?.split("\n").slice(0, 3).join(" | ")}`)
    .join("\n")}\n    ${v.helpUrl}`;

/**
 * Runs axe on the current page state. Serious/critical violations fail the test; moderate/minor ones are attached as
 * `a11y-moderate` annotations so they show in the HTML report without blocking.
 */
export async function expectNoBlockingViolations(page: Page, info: TestInfo, opts: ScanOptions = {}): Promise<void> {
  let axe = new AxeBuilder({ page }).withTags(WCAG_TAGS);
  if (opts.knownRules?.length) axe = axe.disableRules(opts.knownRules);
  for (const sel of opts.exclude ?? []) axe = axe.exclude(sel);
  const { violations } = await axe.analyze();
  for (const v of violations.filter((x) => !BLOCKING.has(x.impact ?? ""))) {
    info.annotations.push({ type: "a11y-moderate", description: `${page.url()}: ${v.id} (${v.nodes.length} node(s)) ${v.help}` });
  }
  const blocking = violations.filter((v) => BLOCKING.has(v.impact ?? ""));
  expect(blocking.map(fmt), `serious/critical WCAG 2.2 AA violations on ${page.url()}`).toEqual([]);
}

/** Strict variant for `test.fixme` bug trackers: fails if `rule` has ANY violation (any impact) on the page. */
export async function expectRuleClean(page: Page, rule: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).withRules([rule]).analyze();
  expect(violations.map(fmt), `${rule} on ${page.url()}`).toEqual([]);
}

/** Waits for the page to be hydrated enough to scan: main landmark present, network idle-ish, fonts ready. */
export async function settle(page: Page): Promise<void> {
  await page.locator("main, [role=main]").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState("networkidle").catch(() => undefined);
}
