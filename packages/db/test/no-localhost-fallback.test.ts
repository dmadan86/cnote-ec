// Security audit M8: no silent localhost fallback for DATABASE_URL in production.
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  delete (globalThis as { prisma?: unknown }).prisma;
});

async function load() {
  vi.resetModules();
  delete (globalThis as { prisma?: unknown }).prisma;
  return import("../src");
}

describe("DATABASE_URL in production", () => {
  it("importing without a URL does not throw (next build / typegen), but any use fails loudly instead of connecting to localhost", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "");
    const { prisma } = await load();
    expect(() => prisma.person).toThrow(/DATABASE_URL is required in production/);
    expect(() => (prisma as unknown as { $queryRaw: unknown }).$queryRaw).toThrow(/no localhost fallback/);
    // awaiting / inspecting the placeholder must not blow up in unrelated code paths
    expect((prisma as unknown as { then: unknown }).then).toBeUndefined();
    expect(Object.prototype.toString.call(prisma)).toBe("[object Object]");
  });

  it("with a URL (or outside production) it builds a real client", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", process.env.DATABASE_URL ?? "postgres://cnote:cnote@localhost:5432/cnote_test");
    const real = await load();
    expect(() => real.prisma.person).not.toThrow();
    await real.prisma.$disconnect();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "");
    const dev = await load();
    expect(() => dev.prisma.person).not.toThrow(); // dev keeps the localhost convenience
    await dev.prisma.$disconnect();
  });
});
