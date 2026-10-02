import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FilterActions, FilterBar, FilterCheckbox, FilterField, FilterInput, FilterSelect, SectionNav } from "./filters";

const html = renderToStaticMarkup(
  <FilterBar label="Filter things">
    <FilterField label="Side" width="sm">
      <FilterSelect name="side" defaultValue="">
        <option value="">All</option>
      </FilterSelect>
    </FilterField>
    <FilterField label="Name">
      <FilterInput name="q" />
    </FilterField>
    <FilterCheckbox label="Flagged only" name="flagged" value="1" />
    <FilterActions clearHref="/things" />
  </FilterBar>,
);

const classOf = (tag: string) => new RegExp(`<${tag}\\b[^>]*class="([^"]*)"`).exec(html)?.[1] ?? "";

describe("filter primitives", () => {
  it("renders an accessible GET form that bottom-aligns its children", () => {
    expect(html).toMatch(/^<form role="search" aria-label="Filter things" class="flex flex-wrap items-end gap-3" method="get">/);
  });
  it("puts the label above the control", () => {
    expect(html).toMatch(/<label class="flex w-full flex-col gap-1 text-xs font-medium text-muted sm:w-36"><span>Side<\/span><select/);
  });
  it("gives controls and the button the same height at every breakpoint", () => {
    for (const tag of ["select", "input", "button"]) {
      const cls = classOf(tag);
      expect(cls, tag).toContain("h-9");
      expect(cls, tag).toContain("lg:h-9");
      // tailwind-merge must have dropped the @cnote/ui defaults
      expect(cls, tag).not.toMatch(/\b(h-11|h-8|h-10|lg:h-10|lg:h-8)\b/);
    }
  });
  it("centres the checkbox in a control-height row and offers a Clear link", () => {
    expect(html).toMatch(/<label class="[^"]*\bh-9\b[^"]*"><input type="checkbox"/);
    expect(html).toContain('href="/things"');
    expect(html).toContain(">Clear<");
  });
  it("SectionNav renders labelled in-page anchors", () => {
    const nav = renderToStaticMarkup(<SectionNav items={[{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }]} />);
    expect(nav).toContain('aria-label="Sections"');
    expect(nav).toContain('href="#a"');
    expect(nav).toContain(">Beta<");
  });
});

// Every filter form must use FilterBar. A bare <form> without an `action` submits as GET (a filter form), and
// `method="get"` is only allowed inside FilterBar itself. Documented exceptions: forms with their own onSubmit handler.
const SRC = path.resolve(import.meta.dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".tsx") && !p.endsWith(".test.tsx") ? [p] : [];
  });

describe("filter forms use FilterBar", () => {
  const forms = ["app", "features"].flatMap((d) => files(path.join(SRC, d))).flatMap((f) =>
    [...readFileSync(f, "utf8").matchAll(/<form\b([^>]*)>/g)].map((m) => ({ file: path.relative(SRC, f), attrs: m[1] ?? "" })),
  );
  it("finds the forms it is scanning", () => expect(forms.length).toBeGreaterThan(5));
  it('no <form method="get"> outside FilterBar', () => {
    expect(forms.filter((f) => /method="get"/i.test(f.attrs)).map((f) => f.file)).toEqual([]);
  });
  it("no <form> without an action (an implicit GET filter form), except those with onSubmit", () => {
    expect(forms.filter((f) => !/\baction=/.test(f.attrs) && !/\bonSubmit=/.test(f.attrs)).map((f) => f.file)).toEqual([]);
  });
});
