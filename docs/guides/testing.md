# Testing guide

Three layers, all runnable locally and in CI (`.github/workflows/ci.yml`).

| Layer | Command | Where | Needs |
| --- | --- | --- | --- |
| Unit / integration (Vitest) | `pnpm test`, `pnpm --filter @cnote/enquiry test` | `packages/*/test`, `apps/*/test` | Postgres + Redis (isolated `*_test` DBs, Redis DB 1) |
| Coverage thresholds | `pnpm test:coverage` | per-package thresholds in `vitest.shared.ts` | same |
| Accessibility (axe + keyboard) | `pnpm test:a11y` | `e2e/a11y` | built apps, Playwright Chromium |
| End-to-end journeys | `pnpm test:e2e` | `e2e/functional` | same |

## Unit tests and coverage

```bash
pnpm db:test:prepare          # once: create/migrate cnote_test + cnote_live_test
pnpm test                     # all workspaces
pnpm --filter @cnote/enquiry exec vitest run test/matching.test.ts -t "cascades"
pnpm test:coverage            # fails when a package drops below its threshold
```

`vitest.setup.ts` points every test at the `_test` databases and Redis logical DB 1, so tests never touch dev data.

## UI tests (Playwright)

Layout (one root-level suite, not per app):

```
playwright.config.ts        projects, webServer, reporters
e2e/
  a11y/                     pnpm test:a11y
    buyer-pages.spec.ts       axe WCAG 2.2 AA scans, English + Hindi
    keyboard.spec.ts          skip link, focus visible, popovers, no traps (desktop)
    mobile.mobile.spec.ts     axe at 412px, touch targets, menu dialog (mobile project)
  functional/               pnpm test:e2e
    buyer.spec.ts             sign up / in, search -> product -> save/compare, RFQ, language switch
    seller.spec.ts            sign up, onboarding, listing -> review, portal, language switch
  support/                  env.ts (single source of e2e env), auth.ts, a11y.ts, pages.ts
  setup/                    prepare-db.ts, build.ts, backfill-live.ts
```

Projects: `desktop` (Desktop Chrome, all specs except `*.mobile.spec.ts`) and `mobile` (Pixel 7, only `*.mobile.spec.ts`).

### First run

```bash
brew services start postgresql@17 redis     # or: docker compose up -d
pnpm exec playwright install chromium       # once
pnpm test:e2e:build                         # creates + migrates + seeds the e2e DBs, builds web and seller
pnpm test:a11y
pnpm test:e2e
pnpm exec playwright show-report            # HTML report (traces on failure)
```

Useful flags: `--project=desktop`, `-g "pricing"`, `--headed`, `--ui`, `--debug`.

### How the environment works

- Databases: dedicated `cnote_e2e` and `cnote_live_e2e` (Postgres), Redis logical DB 2. Override with `E2E_PG_BASE`,
  `E2E_DATABASE_URL`, `E2E_LIVE_DATABASE_URL`, `E2E_REDIS_URL` (see `e2e/support/env.ts`). `prepare-db.ts` refuses to
  touch a database whose name does not end in `_e2e`, or Redis DB 0.
- `pnpm test:e2e:prepare` (also run by the config's first `webServer`) creates the databases, migrates both schemas,
  runs the seed (`apps/worker/src/seed.ts`), projects the seeded listings into the live read DB (normally the worker's job)
  and flushes the e2e Redis DB. It is idempotent. Playwright starts `webServer` entries in order, so the app servers only
  boot once the data exists.
- Apps run as production builds (`next start`) on :3000 (buyer web) and :3002 (seller). `pnpm test:e2e:build` builds them
  against the seeded DB (needed: static pages read the catalogue at build time). Set `E2E_DEV=1` to use `next dev` instead.
  Rebuild after changing app code; running servers are reused locally, never in CI.
- Bot check: `HUMAN_VERIFIER=off` (Turnstile is bypassed explicitly, `packages/security/src/human.ts`). `AI_PROVIDER=heuristic`,
  `QUEUE_DRIVER=memory`, `OTP_DEV_ECHO=true` (the OTP is shown on screen). Feature flags stay off; a spec that needs one
  sets it in `e2e/support/env.ts` with a comment.
- Seed logins: `buyer-demo@example.com` / `DemoBuyer#2026`, `seller-demo@example.com` / `DemoSeller#2026`. Do not build
  specs that depend on specific seed rows; discover data through the UI (`support/pages.ts`).
- The worker is not started: specs must not depend on async fan-out (emails, matching cascades).

### Accessibility suite

- axe tags: `wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa`. **Serious and critical fail the test**; moderate and minor are
  attached as `a11y-moderate` annotations in the HTML report.
- English and Hindi for every localised public page (home, search, categories, category, product, manufacturers, pricing,
  dispute policy, ranking and ads). Sign-in, sign-up and the RFQ form are not localised yet (`LOCALIZED_PREFIXES` in
  `apps/web/src/i18n/config.ts`), so they are scanned once in English. Add a page to the table in `buyer-pages.spec.ts`.
- Keyboard checks are behavioural (skip link, focus indicator, popover Enter/Escape/Tab-out, no traps, dialog focus loop).
- The seller and admin apps are not held to the a11y gate (CLAUDE.md), so there are no axe scans for them.

### Known bugs (`test.fixme`)

A defect found by a spec that cannot be fixed in the same change is tracked, not deleted:

1. Exclude the rule from the blocking scan (`expectNoBlockingViolations(page, info, { knownRules: [...] })`).
2. Add a sibling `test.fixme("BUG-... ", ...)` that asserts the rule strictly (`expectRuleClean`), with a comment naming the
   file, the cause and the suggested fix.
3. When the bug is fixed, delete `knownRules` and change `test.fixme` to `test`.

Search for `BUG-` under `e2e/` for the current list.

### Conventions

- Query by role, label or visible text (`getByRole`, `getByLabel`). No `data-testid`, no CSS selectors, no fixed sleeps:
  rely on auto-waiting and web-first assertions (`expect(locator)...`). Prefer `getByRole("textbox", { name })` over
  `getByLabel` where a label text also matches a button's `aria-label`.
- Every spec is independent: create a unique user with `uniqueEmail()` / `signUpBuyer()` and never mutate the seeded demo
  accounts' state beyond adding rows. Specs run fully parallel.
- Keep specs fast: sign up through the UI only where sign-up is under test; helpers in `e2e/support` cover the rest.
- Every new user-facing string must exist in English and Hindi (a unit test enforces key parity); a11y specs should be
  extended for new public buyer pages.
- Debugging CI failures: download the `playwright-report` artifact (HTML report) and `playwright-traces` (open with
  `pnpm exec playwright show-trace <trace.zip>`).

### CI

The `e2e` job is separate from `check` (own Postgres pgvector + Redis services, cached Playwright browsers, builds the two
apps, runs `pnpm exec playwright test` for both suites, uploads the report always and traces on failure). Make it a
required status check in branch protection when the team is ready.
