import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@cnote/db";
import { KEY, resetPrincipal } from "./helpers";
import { state } from "./helpers";

vi.mock("@cnote/core", async (orig) => ({ ...(await orig<typeof import("@cnote/core")>()), rateLimit: vi.fn(async () => true) }));
vi.mock("@cnote/developer", () => ({
  hasScope: () => true,
  verifyApiKey: vi.fn(async (secret: string) => (secret === "ck_live_testsecret" ? state.principal : null)),
}));

const { createApp } = await import("../src/app");
const app = createApp();
let biz: string;
let person: string;

beforeAll(async () => {
  biz = (await prisma.business.create({ data: { name: `api-badid-${Date.now()}` } })).id;
  person = (await prisma.person.create({ data: { email: `api-badid-${Date.now()}@example.test` } as never })).id;
  resetPrincipal(["x"], biz);
  state.principal = { keyId: "k", personId: person, businessId: biz, scopes: ["x"] };
});

afterAll(async () => {
  await prisma.person.deleteMany({ where: { id: person } });
  await prisma.business.deleteMany({ where: { id: biz } });
});

const spec = await (await app.request("/openapi.json")).json();
const cases: [string, string, string][] = [];
for (const [path, item] of Object.entries<Record<string, any>>(spec.paths)) {
  if (!path.includes("{")) continue;
  for (const method of Object.keys(item)) cases.push([method.toUpperCase(), path, `${method.toUpperCase()} ${path}`]);
}

// Regression: Postgres 22P02 on non-uuid ids used to surface as HTTP 500.
describe("malformed ids never become 500s", () => {
  it.each(cases)("%s %s", async (method, path) => {
    const url = path.replace(/\{[^}]+\}/g, "not-a-uuid");
    const r = await app.request(url, { method, headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify({ body: "hello there friend", listingId: "not-a-uuid", rating: 5, outcome: "won", pricePaise: 1, quantity: 1, unit: "kg" }) });
    expect(r.status, await r.clone().text()).toBeLessThan(500);
  });
});

describe("default health check (real Postgres + Redis test stores)", () => {
  it("reports ok", async () => {
    const r = await app.request("/health");
    expect(await r.json()).toMatchObject({ status: "ok", postgres: true, redis: true });
  });
});
