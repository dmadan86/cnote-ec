import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// <Alert> from @cnote/ui is itself the live region (role="alert" for danger, role="status" otherwise). Wrapping its content
// in another role="alert"/"status" makes screen readers announce the message twice (WCAG 4.1.3 noise), as the dispute
// forms did. Keep exactly one live region.
const ROOTS = [path.resolve(import.meta.dirname, "../src"), path.resolve(import.meta.dirname, "../../seller/src"), path.resolve(import.meta.dirname, "../../../packages/ui/src")];
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".tsx") ? [p] : [];
  });

describe("single live region per Alert", () => {
  it("no component nests role=alert/status inside <Alert>", () => {
    const bad = ROOTS.flatMap(files).filter((f) => /<Alert\b[^>]*>\s*<[A-Za-z]+\b[^>]*\brole="(?:alert|status)"/.test(readFileSync(f, "utf8")));
    expect(bad).toEqual([]);
  });
  it("the dispute forms render the Alert directly", () => {
    for (const f of ["../src/features/disputes/forms.tsx", "../../seller/src/features/disputes/forms.tsx"]) {
      const src = readFileSync(path.resolve(import.meta.dirname, f), "utf8");
      expect(src).toMatch(/<Alert tone="danger">\{/);
      expect(src).not.toMatch(/role="(?:alert|status)"/);
    }
  });
});
