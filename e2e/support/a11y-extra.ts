import { expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { WEB_URL } from "./env";

export type Locale = "en" | "hi";

/** The buyer web remembers the language in `cnote_locale` for the pages that are not under /<locale>/ (account, orders, ...). */
export async function setLocaleCookie(context: BrowserContext, locale: Locale, baseURL?: string): Promise<void> {
  await context.addCookies([{ name: "cnote_locale", value: locale, url: baseURL ?? WEB_URL }]);
}

/** Does the focused element show a focus indicator (outline or ring shadow)? WCAG 2.4.7 / 2.4.11. */
export async function activeHasFocusIndicator(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return false;
    const cs = getComputedStyle(el);
    return (cs.outlineStyle !== "none" && (parseFloat(cs.outlineWidth) || 0) > 0) || (cs.boxShadow !== "none" && cs.boxShadow !== "");
  });
}

/**
 * Presses Tab until `target` has focus (a keyboard user must be able to reach it without a trap), then asserts that the
 * focused control shows a visible focus indicator. Starts from the top of the document.
 */
export async function reachByKeyboard(page: Page, target: Locator, max = 90): Promise<void> {
  await expect(target.first()).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const handle = await target.first().elementHandle();
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    if (await handle!.evaluate((el) => el === document.activeElement)) {
      expect(await activeHasFocusIndicator(page), "focused control has a visible focus indicator").toBe(true);
      return;
    }
  }
  throw new Error(`could not reach ${target} with ${max} Tab presses (keyboard trap or missing tab stop?)`);
}

/**
 * Error-state contract (WCAG 3.3.1, 3.3.3, 4.1.3): after a failed submit, every invalid control is aria-invalid, points at
 * visible error text through aria-describedby, and the failure is announced (a role=alert/status live region has text).
 */
export async function expectAnnouncedErrors(page: Page, opts: { fieldLevel?: boolean; scope?: Locator } = {}): Promise<void> {
  const scope = opts.scope ?? page.locator("main");
  await expect(scope.locator("[role=alert]:visible, [aria-live=assertive]:visible, [role=status]:visible").filter({ hasText: /\S/ }).first()).toBeVisible();
  const invalid = scope.locator("[aria-invalid='true']");
  // Field-level forms (the @cnote/ui Field) must flag the offending control; form-level server errors only need the live region.
  if (opts.fieldLevel) expect(await invalid.count(), "at least one control is marked aria-invalid").toBeGreaterThan(0);
  const broken = await invalid.evaluateAll((els) =>
    els.flatMap((el) => {
      const ids = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
      const texts = ids.map((id) => document.getElementById(id)?.textContent?.trim() ?? "");
      return texts.some(Boolean) ? [] : [`${el.tagName.toLowerCase()}#${el.id || el.getAttribute("name") || "?"} has no described-by error text`];
    }),
  );
  expect(broken).toEqual([]);
}

/** Interactive controls in `root` that are smaller than `min` css px (either dimension), excluding inline text links in prose. */
export async function smallTargets(page: Page, root: string, min: number): Promise<string[]> {
  return page.evaluate(
    ({ root, min }) => {
      const out: string[] = [];
      const sel = "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=switch], [role=tab], [role=menuitem]";
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(`${root} ${sel}`))) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (r.width === 0 || r.height === 0 || cs.visibility === "hidden" || cs.display === "none") continue;
        // skip-link style off-screen controls and visually hidden inputs (their label is the target)
        if (r.right < 0 || r.bottom < 0 || (r.width <= 1 && r.height <= 1)) continue;
        if (el.closest("[hidden], [aria-hidden='true'], [inert]")) continue;
        const inProse = el.tagName === "A" && cs.display === "inline" && !!el.closest("p, li, dd, td");
        if (inProse) continue; // WCAG 2.5.8 exception: inline links in a sentence
        const labelled = el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio") ? el.closest("label")?.getBoundingClientRect() : null;
        const w = Math.max(r.width, labelled?.width ?? 0);
        const h = Math.max(r.height, labelled?.height ?? 0);
        if (w < min || h < min) out.push(`${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? el.getAttribute("name") ?? "").trim().slice(0, 40)}" ${Math.round(w)}x${Math.round(h)}`);
      }
      return out;
    },
    { root, min },
  );
}

/**
 * A form that relies on native constraint validation (`required`): the browser blocks the submit, moves focus to the first
 * invalid control and announces its validation message. Passes when focus is on an :invalid control with a message.
 */
export async function expectSubmitRejected(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => { const el = document.activeElement as HTMLInputElement | null; return !!el && el.matches(":invalid") && !!el.validationMessage; }))
    .toBe(true);
}
