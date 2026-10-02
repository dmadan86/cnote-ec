/**
 * Runtime cookie audit (docs/design/cookie-consent.md, "Single source of truth"). The unit test in apps/web/test only
 * greps source for quoted `cnote_*` keys; this one looks at what a real browser ACTUALLY holds after visiting the home page,
 * search, a product page and /cookies in three states (no choice, Reject all, Accept all), and fails when
 *   - a cookie, localStorage key or sessionStorage key is not in the registry (features/consent/registry.ts), or
 *   - after "no choice" or "Reject all", anything non-necessary is stored (DPDP s.6, ePrivacy Art 5(3)).
 * The registry is imported straight from the app, so the audit can never drift from what the cookie policy lists.
 */
import { STORAGE_REGISTRY, type StorageKind } from "../../apps/web/src/features/consent/registry";
import { expect, test, type Page } from "../support/fixtures";
import { settle } from "../support/a11y";
import { firstProductHref } from "../support/pages";

test.use({ consent: false });
// Each test walks four pages (plus a search to find a product); allow for a cold CI server.
test.setTimeout(180_000);

// Production prefixes the auth cookies with `__Host-` (packages/identity cookieNames); the registry lists the bare names.
const bare = (name: string) => name.replace(/^__Host-/, "");
const known = (kind: StorageKind) => new Map(STORAGE_REGISTRY.filter((e) => e.kind === kind).map((e) => [e.name, e.category]));

interface Held {
  cookie: string[];
  localStorage: string[];
  sessionStorage: string[];
}

async function held(page: Page): Promise<Held> {
  const cookie = (await page.context().cookies()).map((c) => bare(c.name));
  const web = await page.evaluate(() => ({ localStorage: Object.keys(localStorage), sessionStorage: Object.keys(sessionStorage) }));
  return { cookie, ...web };
}

/** Every held key must be registered under the right kind; returns the registry category of each, for the state assertions. */
function audit(where: string, h: Held): { key: string; kind: StorageKind; category: string }[] {
  const out: { key: string; kind: StorageKind; category: string }[] = [];
  for (const kind of ["cookie", "localStorage", "sessionStorage"] as const) {
    const registry = known(kind);
    for (const key of h[kind]) {
      const category = registry.get(key);
      expect(category, `${where}: ${kind} "${key}" is not in the consent registry (apps/web/src/features/consent/registry.ts). Register it, or stop writing it.`).toBeDefined();
      out.push({ key, kind, category: category! });
    }
  }
  return out;
}

const pdpHref = new WeakMap<Page, string>();
async function pagesToVisit(page: Page): Promise<{ name: string; path: string }[]> {
  if (!pdpHref.has(page)) pdpHref.set(page, await firstProductHref(page));
  return [
    { name: "home", path: "/" },
    { name: "search", path: "/search?q=box" },
    { name: "product page", path: pdpHref.get(page)! },
    { name: "cookie policy", path: "/cookies" },
  ];
}

/** Visits every page, auditing after each load and again after the page settled. Returns everything seen in the end. */
async function browse(page: Page, state: string, after?: () => Promise<void>) {
  let last: ReturnType<typeof audit> = [];
  for (const { name, path } of await pagesToVisit(page)) {
    await page.goto(path);
    await settle(page);
    if (after) await after();
    last = audit(`${state} / ${name}`, await held(page));
  }
  return last;
}

const nonNecessary = (seen: ReturnType<typeof audit>) => seen.filter((s) => s.category !== "necessary").map((s) => `${s.kind}:${s.key}`);

test.describe("runtime cookie audit", () => {
  test("no choice yet: only registered keys, and nothing non-essential", async ({ page }) => {
    const seen = await browse(page, "no choice");
    expect(nonNecessary(seen), "storage that needs consent was written before the visitor chose").toEqual([]);
    // the visitor id is created only when a lead CTA is used, and only with marketing consent
    expect(seen.map((s) => s.key)).not.toContain("cnote_vid");
  });

  test("Reject all: only registered keys, and no analytics/marketing keys on any page", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await page.getByRole("region", { name: "Cookie notice" }).getByRole("button", { name: "Reject all" }).click();
    await expect(page.getByRole("region", { name: "Cookie notice" })).toHaveCount(0);
    const seen = await browse(page, "reject all");
    expect(nonNecessary(seen), "something non-essential is stored after Reject all").toEqual([]);
    // the consent record itself is there (strictly necessary: it is the proof), and the unsent-receipt outbox drained
    expect(seen.map((s) => s.key)).toContain("cnote_consent");
    await expect.poll(async () => (await held(page)).localStorage.includes("cnote_consent_pending"), { message: "the pending receipt was never acknowledged by POST /api/consent" }).toBe(false);
  });

  test("Accept all: every key written is registered (analytics and marketing included)", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await page.getByRole("region", { name: "Cookie notice" }).getByRole("button", { name: "Accept all" }).click();
    await expect(page.getByRole("region", { name: "Cookie notice" })).toHaveCount(0);
    await browse(page, "accept all");
    // exercise the marketing writers too: using a lead CTA creates the visitor id (features/leadgen/visitor.ts)
    await page.goto(pdpHref.get(page)!);
    await settle(page);
    await page.getByRole("button", { name: /get best price|contact seller/i }).first().click();
    const seen = audit("accept all / after lead CTA", await held(page));
    expect(seen.map((s) => s.key)).toContain("cnote_vid");
  });
});
