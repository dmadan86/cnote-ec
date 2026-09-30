// Run from the repo root: pnpm test:boundaries  (= npx vitest run scripts/check-boundaries.test.ts)
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  ALLOWLIST, accessorOf, findCycles, findFrameworkImports, findImports, findModelUsages, findRawSqlUsages, formatViolations, parseSchema, runChecks,
} from "./check-boundaries";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("the real repository", () => {
  it("has no boundary violations", () => {
    expect(formatViolations(runChecks(REPO))).toBe("");
  });

  it("every allowlist entry has a reason, and debt entries are marked", () => {
    for (const a of ALLOWLIST) {
      expect(a.reason.length).toBeGreaterThan(20);
      expect(a.models.length).toBeGreaterThan(0);
    }
  });
});

describe("findImports", () => {
  it("finds static, dynamic, re-export and side-effect imports with sub-paths, ignoring comments", () => {
    const src = [
      `import { a } from "@cnote/core";`,
      `import type { B } from '@cnote/db/generated';`,
      `const c = await import("@cnote/ai");`,
      `export * from "@cnote/identity";`,
      `import "@cnote/ui";`,
      `// import x from "@cnote/billing";`,
      ` * from "@cnote/search"`,
      `import z from "zod";`,
    ].join("\n");
    expect(findImports(src)).toEqual([
      { pkg: "@cnote/core", line: 1 }, { pkg: "@cnote/db", line: 2 }, { pkg: "@cnote/ai", line: 3 }, { pkg: "@cnote/identity", line: 4 }, { pkg: "@cnote/ui", line: 5 },
    ]);
  });
});

describe("findFrameworkImports", () => {
  it("flags next, next/*, react, react-dom but not lookalikes", () => {
    const src = `import a from "next/navigation";\nimport b from "react";\nimport c from "react-dom/server";\nimport d from "next-auth";\nimport e from "reactive";\nimport f from "next";`;
    expect(findFrameworkImports(src).map((f) => f.spec)).toEqual(["next/navigation", "react", "react-dom/server", "next"]);
  });
});

describe("findCycles", () => {
  it("returns nothing for a DAG and the path for a cycle", () => {
    expect(findCycles({ a: ["b", "c"], b: ["c"], c: [] })).toEqual([]);
    expect(findCycles({ a: ["b"], b: ["c"], c: ["a"] })).toEqual([["a", "b", "c", "a"]]);
    expect(findCycles({ a: ["a"] })).toEqual([["a", "a"]]);
  });
});

describe("parseSchema", () => {
  it("single owner owns every model; a non-model parenthetical is ignored; tables come from @@map", () => {
    const s = parseSchema(`// Owned by @cnote/catalogue (Catalogue + Moderation). ADR-003.\n\nenum X { a }\nmodel ListingImage {\n  id String @id\n  @@map("listing_images")\n}\nmodel Category {\n  id String\n}\n`);
    expect([...s.owners]).toEqual([["ListingImage", "@cnote/catalogue"], ["Category", "@cnote/catalogue"]]);
    expect(s.tables.get("ListingImage")).toBe("listing_images");
    expect(s.tables.get("Category")).toBe("Category");
  });

  it("splits ownership when the header lists models per owner", () => {
    const s = parseSchema(`// Owned by @cnote/email (EmailMessage) and @cnote/notifications (Notification, NotificationPreference).\nmodel EmailMessage {\n id String\n}\nmodel Notification {\n id String\n}\nmodel NotificationPreference {\n id String\n}\n`);
    expect(Object.fromEntries(s.owners)).toEqual({ EmailMessage: "@cnote/email", Notification: "@cnote/notifications", NotificationPreference: "@cnote/notifications" });
  });

  it("applies platform overrides and leaves headerless files unowned", () => {
    const s = parseSchema(`// Cross-cutting: event log.\nmodel DomainEvent {\n id Int\n}\nmodel Other {\n id Int\n}\n`);
    expect(s.owners.get("DomainEvent")).toBe("@cnote/core");
    expect(s.owners.has("Other")).toBe(false);
  });

  it("accessor names are camelCase", () => {
    expect(accessorOf("ListingImage")).toBe("listingImage");
  });
});

describe("findModelUsages / findRawSqlUsages", () => {
  const acc = new Map([["listing", "Listing"], ["listingImage", "ListingImage"]]);
  it("detects prisma./tx. accessors and <x>.<accessor>.<method>, not comments, not longer names", () => {
    const src = [
      `await prisma.listing.findMany();`,
      `await tx.listingImage.create({});`,
      `await this.db.listing.count();`,
      `// prisma.listing.findMany()`,
      `await prisma.listingVersion.findMany();`,
      `const listing = 1; listing.name;`,
    ].join("\n");
    expect(findModelUsages(src, acc)).toEqual([{ model: "Listing", line: 1 }, { model: "ListingImage", line: 2 }, { model: "Listing", line: 3 }]);
  });

  it("detects raw SQL table references", () => {
    const tables = new Map([["listings", "Listing"]]);
    const src = "await prisma.$queryRaw`SELECT 1 FROM listings l JOIN listings x ON true`;\n// FROM listings\nconst s = 'from listings';";
    expect(findRawSqlUsages(src, tables)).toEqual([{ model: "Listing", line: 1 }, { model: "Listing", line: 1 }]);
  });
});

describe("runChecks on a synthetic repo", () => {
  const root = mkdtempSync(path.join(tmpdir(), "boundaries-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const put = (rel: string, content: string) => {
    const f = path.join(root, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, content);
  };
  const pkg = (dir: string, name: string, deps: string[] = []) =>
    put(`${dir}/package.json`, JSON.stringify({ name, dependencies: Object.fromEntries(deps.map((d) => [d, "workspace:*"])) }));

  put("packages/db/prisma/schema/a.prisma", `// Owned by @cnote/a\nmodel Widget {\n id String @id\n @@map("widgets")\n}\n`);
  put("packages/db/prisma/schema/orphan.prisma", `model Lost {\n id String @id\n}\n`);
  pkg("packages/db", "@cnote/db");
  pkg("packages/a", "@cnote/a", ["@cnote/db"]);
  pkg("packages/b", "@cnote/b", ["@cnote/a"]);
  pkg("apps/site", "@cnote/site", ["@cnote/a"]);
  put("packages/a/src/index.ts", `import { x } from "@cnote/db";\nimport y from "@cnote/b";\nimport n from "next/headers";\nexport const w = prisma.widget.findMany();\n`);
  put("packages/b/src/index.ts", `import { prisma } from "@cnote/db";\nexport const w = () => prisma.widget.findMany();\nexport const r = tx.$queryRaw\`SELECT * FROM widgets\`;\n`);
  put("apps/site/src/page.tsx", `import a from "@cnote/a";\nimport b from "@cnote/b";\nimport r from "react";\n`);

  const allowedDeps = { "@cnote/db": [], "@cnote/a": ["@cnote/db"], "@cnote/b": [] };
  const vs = runChecks(root, { allowlist: [], allowedDeps, frameworkPackages: {} });
  const has = (rule: string, file: string, line: number) => vs.some((v) => v.rule === rule && v.file === file && v.line === line);

  it("reports undeclared imports with file:line, in packages and apps, but not declared ones", () => {
    expect(has("declared-deps", "packages/a/src/index.ts", 2)).toBe(true);
    expect(has("declared-deps", "apps/site/src/page.tsx", 2)).toBe(true);
    expect(has("declared-deps", "packages/b/src/index.ts", 1)).toBe(true);
    expect(vs.filter((v) => v.rule === "declared-deps")).toHaveLength(3);
  });

  it("rejects declared edges the allowed graph does not permit", () => {
    expect(has("allowed-graph", "packages/b/package.json", 1)).toBe(true);
    expect(vs.filter((v) => v.rule === "allowed-graph")).toHaveLength(1);
  });

  it("keeps domain packages framework-free but lets apps import react", () => {
    expect(has("framework", "packages/a/src/index.ts", 3)).toBe(true);
    expect(vs.filter((v) => v.rule === "framework")).toHaveLength(1);
    expect(runChecks(root, { allowlist: [], allowedDeps, frameworkPackages: { "@cnote/a": "test" } }).some((v) => v.rule === "framework")).toBe(false);
  });

  it("flags foreign model access (accessor and raw SQL) and unowned models, not the owner's own use", () => {
    expect(has("model-ownership", "packages/b/src/index.ts", 2)).toBe(true);
    expect(has("model-ownership", "packages/b/src/index.ts", 3)).toBe(true);
    expect(vs.some((v) => v.rule === "model-ownership" && v.file === "packages/a/src/index.ts")).toBe(false);
    expect(has("model-ownership", "packages/db/prisma/schema/orphan.prisma", 1)).toBe(true);
  });

  it("the allowlist silences exactly the listed workspace/file/model", () => {
    const only = (allow: { pkg: string; file?: string; models: string[] }[]) =>
      runChecks(root, { allowlist: allow.map((a) => ({ ...a, reason: "test" })), allowedDeps, frameworkPackages: {} }).filter((v) => v.rule === "model-ownership" && v.file.startsWith("packages/b"));
    expect(only([{ pkg: "@cnote/b", file: "packages/b/src", models: ["Widget"] }])).toHaveLength(0);
    expect(only([{ pkg: "@cnote/b", models: ["Other"] }])).toHaveLength(2);
    expect(only([{ pkg: "@cnote/a", models: ["Widget"] }])).toHaveLength(2);
    expect(only([{ pkg: "@cnote/b", file: "elsewhere", models: ["Widget"] }])).toHaveLength(2);
  });

  it("detects dependency cycles", () => {
    const cyc = mkdtempSync(path.join(tmpdir(), "boundaries-cyc-"));
    for (const [n, d] of [["x", "y"], ["y", "x"]]) {
      mkdirSync(path.join(cyc, "packages", n), { recursive: true });
      writeFileSync(path.join(cyc, "packages", n, "package.json"), JSON.stringify({ name: `@cnote/${n}`, dependencies: { [`@cnote/${d}`]: "workspace:*" } }));
    }
    const out = runChecks(cyc, { allowlist: [], allowedDeps: { "@cnote/x": ["@cnote/y"], "@cnote/y": ["@cnote/x"] }, frameworkPackages: {} });
    rmSync(cyc, { recursive: true, force: true });
    expect(out.map((v) => v.rule)).toEqual(["cycle"]);
    expect(out[0]!.message).toContain("@cnote/x -> @cnote/y -> @cnote/x");
  });

  it("formats violations as file:line", () => {
    expect(formatViolations([{ rule: "cycle", file: "f.ts", line: 3, message: "m" }])).toBe("f.ts:3  [cycle] m");
  });
});
