import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tag = `clitest-${randomUUID().slice(0, 8)}`;
const email = `${tag}@example.test`;
let personId: string;

async function runCli(...args: string[]) {
  vi.resetModules();
  const orig = process.argv;
  process.argv = ["node", "cli.ts", ...args];
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
  let exitCode: number | undefined;
  const done = new Promise<void>((resolve) => {
    vi.spyOn(process, "exit").mockImplementation(((c?: number) => {
      exitCode = c;
      resolve();
      return undefined as never;
    }) as never);
    // success path: disconnect is called; poll via prisma.$disconnect spy
    const d = vi.spyOn(prisma, "$disconnect").mockImplementation((async () => {
      resolve();
    }) as never);
    void d;
  });
  await import("../src/cli");
  await done;
  process.argv = orig;
  return { exitCode, out: log.mock.calls.map((c) => c.join(" ")).join("\n"), errText: err.mock.calls.map((c) => String(c[0])).join("\n") };
}

beforeEach(async () => {
  const p = await prisma.person.upsert({ where: { email }, create: { email }, update: {} });
  personId = p.id;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await prisma.adminAuditLog.deleteMany({ where: { subjectId: personId } });
  await prisma.staffMember.deleteMany({ where: { personId } });
  await prisma.person.deleteMany({ where: { id: personId } });
});

describe("admin CLI", () => {
  it("no/unknown command prints usage and exits 1", async () => {
    for (const args of [[], ["bogus"]]) {
      const r = await runCli(...args);
      expect(r.exitCode).toBe(1);
      expect(r.errText).toContain("Usage:");
    }
  });
  it("grant validates args: missing email/roles, unknown roles, unknown person", async () => {
    expect((await runCli("grant")).errText).toContain("Usage:");
    expect((await runCli("grant", email)).errText).toContain("Usage:");
    const bad = await runCli("grant", email, "viewer", "godmode");
    expect(bad.errText).toContain("Unknown role(s): godmode");
    const unknown = await runCli("grant", `nobody-${tag}@example.test`, "viewer");
    expect(unknown.errText).toContain("No person with email");
    expect(await prisma.staffMember.count({ where: { personId } })).toBe(0);
  });
  it("grant, list, revoke round-trip with audit rows (staffId null)", async () => {
    const g = await runCli("grant", email, "viewer", "viewer", "support");
    expect(g.exitCode).toBeUndefined();
    expect(g.out).toContain("Granted viewer, support");
    const row = await prisma.staffMember.findUnique({ where: { personId } });
    expect(row).toMatchObject({ active: true, roles: ["viewer", "support"] });
    const list = await runCli("list");
    expect(list.out).toContain(email);
    const rv = await runCli("revoke", email);
    expect(rv.out).toContain("Deactivated");
    expect((await prisma.staffMember.findUnique({ where: { personId } }))!.active).toBe(false);
    const audits = await prisma.adminAuditLog.findMany({ where: { subjectId: personId }, orderBy: { createdAt: "asc" } });
    expect(audits.map((a) => a.action)).toEqual(["staff.grant", "staff.deactivate"]);
    expect(audits.every((a) => a.staffId === null && (a.details as { via: string }).via === "cli")).toBe(true);
    expect((await runCli("revoke")).errText).toContain("Usage:");
  });
});
