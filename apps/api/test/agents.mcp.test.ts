import { beforeEach, describe, expect, it, vi } from "vitest";

const a2a = {
  listMandates: vi.fn(async () => [{ id: "m1" }]),
  getMandate: vi.fn(async () => ({ id: "m1" })),
  listNegotiations: vi.fn(async () => []),
  getNegotiation: vi.fn(async () => ({ id: "n1" })),
  startNegotiation: vi.fn(async () => ({ id: "n1" })),
  sendNegotiationMessage: vi.fn(async () => ({ id: "n1" })),
};
vi.mock("@cnote/a2a", () => a2a);
vi.mock("@cnote/developer", () => ({
  hasScope: (p: { scopes: string[] }, s: string) => p.scopes.includes(s) || (s.endsWith(":read") && p.scopes.includes(s.replace(":read", ":write"))),
}));

const { AGENT_TOOLS } = await import("../src/mcp/tools/agents");
const { hasScope } = await import("@cnote/developer");
const P = { keyId: "k1", personId: "p1", businessId: "b1" as string | null, scopes: ["agents:read"] as string[] };
const tool = (n: string) => AGENT_TOOLS.find((t) => t.name === n)!;
const visible = (scopes: string[]) => AGENT_TOOLS.filter((t) => hasScope({ scopes } as never, t.scope)).map((t) => t.name);

beforeEach(() => vi.clearAllMocks());

describe("agent MCP tools", () => {
  it("exposes the expected tool names", () => {
    expect(AGENT_TOOLS.map((t) => t.name).sort()).toEqual([
      "accept_agent_offer", "get_agent_mandate", "get_agent_negotiation", "list_agent_mandates", "list_agent_negotiations",
      "reject_agent_offer", "send_agent_offer", "start_agent_negotiation", "withdraw_agent_negotiation",
    ]);
  });
  it("filters by scope", () => {
    expect(visible(["agents:read"])).toHaveLength(4);
    expect(visible(["agents:write"])).toHaveLength(9);
    expect(visible(["search:read"])).toHaveLength(0);
  });
  it("descriptions carry the safety rules", () => {
    for (const t of AGENT_TOOLS) expect(t.description).toMatch(/never invent terms/i);
    expect(tool("accept_agent_offer").description).toMatch(/human|people/);
    expect(tool("accept_agent_offer").description).toMatch(/cannot see the other side/i);
  });
  it("requires idempotencyKey on send/accept/reject/withdraw", () => {
    for (const n of ["send_agent_offer", "accept_agent_offer", "reject_agent_offer", "withdraw_agent_negotiation"]) {
      expect((tool(n).input.idempotencyKey as unknown as { safeParse: (v: unknown) => { success: boolean } }).safeParse(undefined).success).toBe(false);
    }
  });
  it("rejects a business-less key", async () => {
    await expect(tool("list_agent_mandates").run({ ...P, businessId: null } as never, { limit: 25 } as never)).rejects.toMatchObject({ code: "forbidden" });
  });
  it("send_agent_offer builds a typed counter as an external agent", async () => {
    await tool("send_agent_offer").run(P as never, {
      type: "counter", negotiationId: "n1", idempotencyKey: "i1", pricePaise: 5, quantity: 2, unit: "pc", leadTimeDays: 3, validUntil: "2026-12-01",
    } as never);
    expect(a2a.sendNegotiationMessage).toHaveBeenCalledWith(
      { personId: "p1", businessId: "b1" }, "n1",
      { type: "counter", offer: { pricePaise: 5, quantity: 2, unit: "pc", leadTimeDays: 3, validUntil: "2026-12-01" } },
      { idempotencyKey: "i1", via: { kind: "external_agent", apiKeyId: "k1" } },
    );
  });
  it("accept/reject/withdraw send the matching type", async () => {
    for (const [n, type] of [["accept_agent_offer", "accept"], ["reject_agent_offer", "reject"], ["withdraw_agent_negotiation", "withdraw"]] as const) {
      await tool(n).run(P as never, { negotiationId: "n1", idempotencyKey: "k" } as never);
      expect(a2a.sendNegotiationMessage).toHaveBeenLastCalledWith(expect.anything(), "n1", { type }, expect.objectContaining({ idempotencyKey: "k" }));
    }
  });
  it("start passes the key as startKey", async () => {
    await tool("start_agent_negotiation").run(P as never, { mandateId: "m", matchId: "x", idempotencyKey: "s" } as never);
    expect(a2a.startNegotiation).toHaveBeenCalledWith(expect.anything(), { mandateId: "m", matchId: "x", startKey: "s" }, { kind: "external_agent", apiKeyId: "k1" });
  });
  it("get_agent_negotiation 404s when the negotiation is not visible", async () => {
    a2a.getNegotiation.mockResolvedValueOnce(null as never);
    await expect(tool("get_agent_negotiation").run(P as never, { negotiationId: "n1" } as never)).rejects.toMatchObject({ code: "not_found" });
  });
});
