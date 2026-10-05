// ADR-002: fake-lead risk signals, labelled export + precision/recall, proactive IVR reachability with link fallback and the 72h refund path.
import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ExotelReachabilityProvider, KnowlarityReachabilityProvider, MockReachabilityProvider, collectSignals, computeFakeLeadRisk, exportFakeLeadLabelsCsv, fakeLeadPrecisionRecall, getReachabilityProvider,
  handleReachabilityCallback, hashIpPrefix, ipPrefix, labelEnquiry, labelledRowsToCsv, listLabelQueue, precisionRecall, proactiveMode, purgeEnquirySignals, recordSignals,
  recordReachabilityResponse, resolveReachabilityChecks, setReachabilityDispatchMode, setReachabilityNotifier, setReachabilityProvider, signReachabilityCallback, startProactiveReachability,
  uaFamily, type ReachabilityMessage,
} from "../src";

setReachabilityDispatchMode("inline");
const SECRET = "test-secret";
const people: string[] = [];
const bizs: string[] = [];
const enquiries: string[] = [];

async function party(phone = `+9199${Math.floor(10_000_000 + Math.random() * 89_999_999)}`) {
  const p = await prisma.person.create({ data: { email: `rr-${randomUUID()}@example.test`, name: "Buyer", phone, phoneVerifiedAt: new Date() } });
  people.push(p.id);
  const b = await prisma.business.create({ data: { name: `Buyer ${randomUUID().slice(0, 6)}` } });
  bizs.push(b.id);
  return { personId: p.id, businessId: b.id };
}
async function seller() {
  const b = await prisma.business.create({ data: { name: `Seller ${randomUUID().slice(0, 6)}`, isSeller: true } });
  bizs.push(b.id);
  return b.id;
}
async function enquiry(buyer: { personId: string; businessId: string }, intentScore = 30, createdAt = new Date()) {
  const e = await prisma.enquiry.create({ data: { buyerBusinessId: buyer.businessId, buyerPersonId: buyer.personId, title: "10 mm steel rods", requirement: "Need 500 kg of 10 mm TMT rods", intentScore, status: "matched", createdAt } });
  enquiries.push(e.id);
  return e.id;
}
async function accepted(enquiryId: string, ago = 3600_000) {
  const m = await prisma.match.create({ data: { enquiryId, sellerBusinessId: await seller(), rank: 1, matchScore: 0.9, status: "accepted", respondBy: new Date(), respondedAt: new Date(Date.now() - ago) } });
  return m.id;
}

const sent: ReachabilityMessage[] = [];
const mock = new MockReachabilityProvider(SECRET);
beforeAll(() => setReachabilityNotifier({ send: async (m) => { sent.push(m); return { channel: "whatsapp" as const }; } }));
beforeEach(() => { process.env.REACHABILITY_CHECK_ENABLED = "true"; process.env.REACHABILITY_PROACTIVE = "low_intent"; process.env.REACHABILITY_WEBHOOK_SECRET = SECRET; sent.length = 0; mock.calls = []; mock.failPlacing = false; setReachabilityProvider(mock); });
afterEach(() => { delete process.env.REACHABILITY_PROACTIVE; delete process.env.REACHABILITY_WEBHOOK_SECRET; setReachabilityProvider(undefined); });
afterAll(async () => {
  setReachabilityNotifier(null);
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: enquiries } } });
  await prisma.reachabilityCheck.deleteMany({ where: { enquiryId: { in: enquiries } } });
  await prisma.enquirySignals.deleteMany({ where: { enquiryId: { in: enquiries } } });
  await prisma.match.deleteMany({ where: { enquiryId: { in: enquiries } } });
  await prisma.enquiry.deleteMany({ where: { id: { in: enquiries } } });
  await prisma.business.deleteMany({ where: { id: { in: bizs } } });
  await prisma.person.deleteMany({ where: { id: { in: people } } });
});

describe("risk signals (pure)", () => {
  it("classifies user agents and never keeps the string", () => {
    expect(uaFamily("Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36")).toBe("chrome-android");
    expect(uaFamily("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit Version/17 Mobile Safari")).toBe("safari-ios");
    expect(uaFamily("python-requests/2.31")).toBe("script");
    expect(uaFamily("HeadlessChrome/120")).toBe("bot");
    expect(uaFamily(undefined)).toBe("none");
    expect(uaFamily("Mozilla/5.0 Firefox/121.0")).toBe("firefox");
  });
  it("hashes only the /24 (v4) or first three hextets (v6), keyed, never the address", () => {
    expect(ipPrefix("203.0.113.45")).toBe("203.0.113");
    expect(hashIpPrefix("203.0.113.45")).toBe(hashIpPrefix("203.0.113.200"));
    expect(hashIpPrefix("203.0.113.45")).not.toBe(hashIpPrefix("203.0.114.45"));
    expect(hashIpPrefix("203.0.113.45")).not.toContain("203");
    expect(ipPrefix("2001:db8:abcd:1::1")).toBe("2001:0db8:abcd");
    expect(ipPrefix("not an ip")).toBeNull();
    expect(hashIpPrefix(null)).toBeNull();
  });
  it("scores clean traffic 0 and stacks reasons for abusive traffic, capped at 100", () => {
    const clean = { uaFamily: "chrome-android" as const, hasIp: true, phoneVerified: true, velocityPerson1h: 0, velocityPerson24h: 1, distinctOtherPersonsOnIp24h: 0 };
    expect(computeFakeLeadRisk(clean)).toEqual({ score: 0, reasons: [] });
    const bad = computeFakeLeadRisk({ uaFamily: "bot", hasIp: false, phoneVerified: false, velocityPerson1h: 6, velocityPerson24h: 12, distinctOtherPersonsOnIp24h: 7 });
    expect(bad.score).toBe(100);
    expect(bad.reasons.length).toBeGreaterThanOrEqual(6);
  });
});

describe("signals, labels, export", () => {
  it("collects velocity per person and per ip-prefix, stores no raw IP, purges the hash", async () => {
    const a = await party(), b = await party();
    for (let i = 0; i < 3; i++) await enquiry(a, 50);
    const ctx = { ip: "198.51.100.7", userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile", phoneVerified: true };
    const s = (await collectSignals(a.personId, ctx))!;
    expect(s).toMatchObject({ velocityPerson1h: 3, velocityPerson24h: 3, uaFamily: "chrome-android" });
    expect(s.risk.score).toBe(20);
    const eid = await enquiry(b, 50);
    await prisma.$transaction((tx) => recordSignals(tx, eid, s));
    const row = await prisma.enquirySignals.findUniqueOrThrow({ where: { enquiryId: eid } });
    expect(JSON.stringify(row)).not.toContain("198.51.100");
    expect(row.ipHash).toHaveLength(64);
    const again = (await collectSignals(a.personId, ctx))!;
    expect(again.velocityIp24h).toBe(1);
    expect(await purgeEnquirySignals(new Date(Date.now() + 1000), { dryRun: true })).toBeGreaterThanOrEqual(1);
    await purgeEnquirySignals(new Date(Date.now() + 1000));
    expect((await prisma.enquirySignals.findUniqueOrThrow({ where: { enquiryId: eid } })).ipHash).toBeNull();
  });

  it("labels emit EnquiryLabelled, feed precision/recall and export CSV without free text, formula-safe", async () => {
    const buyer = await party();
    const mk = async (risk: number, intent: number, label: "genuine" | "fake" | "spam" | "unreachable") => {
      const id = await enquiry(buyer, intent);
      await prisma.enquirySignals.create({ data: { enquiryId: id, uaFamily: label === "fake" ? "=cmd|calc" : "chrome-android", riskScore: risk, riskReasons: [] } });
      await labelEnquiry(id, label, randomUUID());
      return id;
    };
    const tp = await mk(80, 50, "fake");
    await mk(70, 50, "genuine"); // FP
    await mk(10, 10, "spam"); // TP via low intent
    await mk(5, 70, "unreachable"); // FN
    await mk(5, 70, "genuine"); // TN
    expect(await prisma.domainEvent.count({ where: { aggregateId: tp, type: "EnquiryLabelled" } })).toBe(1);
    const pr = await fakeLeadPrecisionRecall({ since: new Date(Date.now() - 60_000) });
    expect(pr.truePositive).toBeGreaterThanOrEqual(2);
    expect(pr.precision).not.toBeNull();
    expect(precisionRecall([{ isFake: true, predictedFake: true }, { isFake: false, predictedFake: true }, { isFake: true, predictedFake: false }, { isFake: false, predictedFake: false }])).toMatchObject({ precision: 0.5, recall: 0.5, labelled: 4 });
    expect(precisionRecall([])).toMatchObject({ precision: null, recall: null });
    const csv = await exportFakeLeadLabelsCsv({ since: new Date(Date.now() - 60_000) });
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("enquiryId,createdAt,label,isFake,riskScore,intentScore,predictedFake,uaFamily,velocityPerson1h,velocityPerson24h,velocityIp24h,reachability");
    expect(csv).not.toContain("steel");
    expect(csv).toContain("'=cmd|calc");
    expect(labelledRowsToCsv([{ enquiryId: "a,b", createdAt: "x", label: '"q"', isFake: true, riskScore: -1, intentScore: null, predictedFake: false, uaFamily: "@x", velocityPerson1h: 0, velocityPerson24h: 0, velocityIp24h: 0, reachability: "none" }])).toContain('"a,b",x,"""q""",true,-1,,false,\'@x');
    expect((await listLabelQueue({ labelled: true, limit: 5 })).length).toBeGreaterThan(0);
    await expect(labelEnquiry(randomUUID(), "fake", randomUUID())).rejects.toThrow(/not found/);
    await expect(labelEnquiry(tp, "nope" as never, randomUUID())).rejects.toThrow(/label/);
  });
});

describe("proactive reachability", () => {
  const post = (e: string, intent: number | null, risk = 0) => startProactiveReachability(e, { intentScore: intent, riskScore: risk });
  const cb = (providerRef: string, outcome: string) => handleReachabilityCallback(JSON.stringify({ providerRef, outcome }), { "x-reachability-signature": signReachabilityCallback(SECRET, JSON.stringify({ providerRef, outcome })) }, new URLSearchParams());

  it("modes: default checks only doubtful enquiries; off and all; disabled flag; once per enquiry", async () => {
    const b = await party();
    const good = await enquiry(b, 90);
    expect(await post(good, 90)).toBeNull();
    const shaky = await enquiry(b, 30);
    expect(await post(shaky, 30)).not.toBeNull();
    expect(await post(shaky, 30)).toBeNull();
    const risky = await enquiry(b, 90);
    expect(await post(risky, 90, 55)).not.toBeNull();
    process.env.REACHABILITY_PROACTIVE = "all";
    expect(proactiveMode()).toBe("all");
    expect(await post(await enquiry(b, 99), 99)).not.toBeNull(); // third check today
    const e4 = await enquiry(b, 99);
    expect(await post(e4, 99)).toBeNull(); // per-buyer cap of 3 per day already used
    const other = await party();
    expect(await post(await enquiry(other, 99), 99)).not.toBeNull();
    process.env.REACHABILITY_PROACTIVE = "off";
    expect(await post(await enquiry(await party(), 10), 10)).toBeNull();
    process.env.REACHABILITY_PROACTIVE = "all";
    process.env.REACHABILITY_CHECK_ENABLED = "false";
    expect(await post(await enquiry(await party(), 10), 10)).toBeNull();
  });

  it("places an IVR call first; press 1 confirms; the check closes as responded and nothing is refunded", async () => {
    const b = await party();
    const e = await enquiry(b, 20);
    const m = await accepted(e);
    const { checkId } = (await post(e, 20))!;
    const c = await prisma.reachabilityCheck.findUniqueOrThrow({ where: { id: checkId } });
    expect(c).toMatchObject({ channel: "ivr", providerRef: `mock_${checkId}`, trigger: "proactive", status: "sent", attempt: 1 });
    expect(mock.calls[0]).toMatchObject({ token: c.token, callbackUrl: expect.stringContaining("/webhooks/reachability?secret=") });
    expect(sent).toHaveLength(0);
    expect(await cb(c.providerRef!, "confirmed")).toMatchObject({ checkId, outcome: "confirmed" });
    expect((await prisma.reachabilityCheck.findUniqueOrThrow({ where: { id: checkId } })).status).toBe("responded");
    expect(await resolveReachabilityChecks()).toBe(0);
    expect((await prisma.match.findUniqueOrThrow({ where: { id: m } })).status).toBe("accepted");
  });

  it("unanswered call falls back to the WhatsApp/SMS link once; the link can still confirm", async () => {
    const e = await enquiry(await party(), 20);
    const { checkId } = (await post(e, 20))!;
    const ref = `mock_${checkId}`;
    await cb(ref, "no_answer");
    await cb(ref, "failed"); // duplicate vendor retry must not send a second link
    const c = await prisma.reachabilityCheck.findUniqueOrThrow({ where: { id: checkId } });
    expect(c).toMatchObject({ attempt: 2, channel: "whatsapp", status: "sent" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.token).toBe(c.token);
    expect(await recordReachabilityResponse(c.token)).toBe("responded");
  });

  it("falls back to the link when telephony cannot place the call; IVR off uses links only", async () => {
    mock.failPlacing = true;
    const e = await enquiry(await party(), 20);
    await post(e, 20);
    expect(sent).toHaveLength(1);
    setReachabilityProvider(null);
    const e2 = await enquiry(await party(), 20);
    const c2 = (await post(e2, 20))!;
    expect(sent).toHaveLength(2);
    expect((await prisma.reachabilityCheck.findUniqueOrThrow({ where: { id: c2.checkId } })).channel).toBe("whatsapp");
  });

  it("no answer inside the window refunds accepted leads still inside 72h, including a lead accepted later; older ones are left alone", async () => {
    const e = await enquiry(await party(), 20);
    const fresh = await accepted(e, 3600_000);
    const stale = await accepted(e, 80 * 3600_000);
    const { checkId } = (await post(e, 20))!;
    await prisma.reachabilityCheck.update({ where: { id: checkId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await resolveReachabilityChecks()).toBe(1);
    expect((await prisma.reachabilityCheck.findUniqueOrThrow({ where: { id: checkId } })).status).toBe("no_response");
    expect((await prisma.match.findUniqueOrThrow({ where: { id: fresh } })).status).toBe("refunded");
    expect((await prisma.match.findUniqueOrThrow({ where: { id: stale } })).status).toBe("accepted");
    expect(await prisma.domainEvent.count({ where: { aggregateId: e, type: "LeadRefunded" } })).toBe(1);
    const late = await accepted(e, 60_000);
    expect(await resolveReachabilityChecks()).toBe(1);
    expect((await prisma.match.findUniqueOrThrow({ where: { id: late } })).refundReason).toBe("buyer_unreachable");
    expect(await resolveReachabilityChecks()).toBe(0);
  });

  it("pressing 2 (not me) ends the check as no_response; unknown references are acknowledged; bad secrets are refused", async () => {
    const e = await enquiry(await party(), 20);
    const m = await accepted(e);
    const { checkId } = (await post(e, 20))!;
    await cb(`mock_${checkId}`, "denied");
    expect((await prisma.reachabilityCheck.findUniqueOrThrow({ where: { id: checkId } })).status).toBe("no_response");
    expect(await resolveReachabilityChecks()).toBe(1);
    expect((await prisma.match.findUniqueOrThrow({ where: { id: m } })).status).toBe("refunded");
    expect(await cb("mock_unknown", "confirmed")).toEqual({ checkId: null, outcome: "unknown_reference" });
    await expect(handleReachabilityCallback('{"providerRef":"x","outcome":"confirmed"}', {}, new URLSearchParams())).rejects.toMatchObject({ code: "forbidden" });
    await expect(handleReachabilityCallback("junk", {}, new URLSearchParams({ secret: SECRET }))).rejects.toMatchObject({ code: "validation" });
    setReachabilityProvider(null);
    await expect(handleReachabilityCallback("{}", {}, new URLSearchParams())).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("telephony adapters", () => {
  const req = { checkId: "c1", phone: "+919900000001", token: "tok", language: "en", enquiryTitle: "t", callbackUrl: "https://api.example/webhooks/reachability?secret=s" };
  it("Exotel places a call to the flow with Basic auth and maps digits to outcomes", async () => {
    let seen: { url: string; auth: string; body: URLSearchParams } | null = null;
    const p = new ExotelReachabilityProvider({
      sid: "acme", key: "k", token: "t", callerId: "0801234", flowId: "99", webhookSecret: "s",
      call: async (url, init) => { seen = { url, auth: new Headers(init.headers).get("authorization")!, body: init.body as URLSearchParams }; return new Response(JSON.stringify({ Call: { Sid: "CS1" } })); },
    });
    expect(await p.place(req)).toEqual({ providerRef: "CS1" });
    expect(seen!.url).toBe("https://api.exotel.com/v1/Accounts/acme/Calls/connect.json");
    expect(seen!.auth).toBe(`Basic ${Buffer.from("k:t").toString("base64")}`);
    expect(seen!.body.get("Url")).toBe("http://my.exotel.com/acme/exoml/start_voice/99");
    expect(seen!.body.get("From")).toBe("+919900000001");
    const q = (extra: Record<string, string>) => new URLSearchParams({ secret: "s", ...extra });
    expect(p.parseCallback("", {}, q({ CallSid: "CS1", digits: '"1"', Status: "completed" }))).toEqual({ providerRef: "CS1", outcome: "confirmed" });
    expect(p.parseCallback("CallSid=CS1&digits=%222%22", {}, q({}))).toEqual({ providerRef: "CS1", outcome: "denied" });
    expect(p.parseCallback("", {}, q({ CallSid: "CS1", Status: "no-answer" })).outcome).toBe("no_answer");
    expect(p.parseCallback("", {}, q({ CallSid: "CS1", Status: "failed" })).outcome).toBe("failed");
    expect(() => p.parseCallback("", {}, new URLSearchParams({ CallSid: "CS1" }))).toThrow(/Invalid callback/);
    expect(() => p.parseCallback("", {}, q({}))).toThrow(/CallSid/);
    const bad = new ExotelReachabilityProvider({ sid: "a", key: "k", token: "t", callerId: "c", flowId: "f", webhookSecret: "s", call: async () => new Response("no", { status: 500 }) });
    await expect(bad.place(req)).rejects.toThrow(/500/);
  });
  it("Knowlarity posts makecall with the api key and parses the webhook", async () => {
    let body: Record<string, unknown> = {};
    let key = "";
    const p = new KnowlarityReachabilityProvider({
      apiKey: "ak", srKey: "sr", kNumber: "+9122000000", agentNumber: "+9122000001", webhookSecret: "s",
      call: async (_u, init) => { body = JSON.parse(String(init.body)); key = new Headers(init.headers).get("x-api-key")!; return new Response(JSON.stringify({ success: { call_id: "K1" } })); },
    });
    expect(await p.place(req)).toEqual({ providerRef: "K1" });
    expect(key).toBe("ak");
    expect(body).toMatchObject({ customer_number: "+919900000001", k_number: "+9122000000" });
    const raw = (o: object) => JSON.stringify(o);
    const hdr = (r: string) => ({ "x-reachability-signature": signReachabilityCallback("s", r) });
    expect(p.parseCallback(raw({ call_id: "K1", dtmf: 1 }), hdr(raw({ call_id: "K1", dtmf: 1 })), new URLSearchParams())).toEqual({ providerRef: "K1", outcome: "confirmed" });
    expect(p.parseCallback(raw({ call_id: "K1", status: "failed" }), hdr(raw({ call_id: "K1", status: "failed" })), new URLSearchParams()).outcome).toBe("failed");
  });
  it("factory: off by default, mock refused in production, vendors need their credentials", () => {
    setReachabilityProvider(undefined);
    expect(getReachabilityProvider({})).toBeNull();
    expect(getReachabilityProvider({ REACHABILITY_IVR_PROVIDER: "mock" })?.name).toBe("mock");
    expect(() => getReachabilityProvider({ REACHABILITY_IVR_PROVIDER: "mock", NODE_ENV: "production" })).toThrow(/production/);
    expect(() => getReachabilityProvider({ REACHABILITY_IVR_PROVIDER: "exotel" })).toThrow(/REACHABILITY_IVR_SID/);
    expect(() => getReachabilityProvider({ REACHABILITY_IVR_PROVIDER: "nope" })).toThrow(/Unknown/);
    const env = { REACHABILITY_IVR_PROVIDER: "exotel", REACHABILITY_IVR_SID: "a", REACHABILITY_IVR_KEY: "k", REACHABILITY_IVR_SECRET: "t", REACHABILITY_IVR_CALLER_ID: "c", REACHABILITY_IVR_FLOW_ID: "f", REACHABILITY_WEBHOOK_SECRET: "s" };
    expect(getReachabilityProvider(env)?.name).toBe("exotel");
    expect(getReachabilityProvider({ ...env, REACHABILITY_IVR_PROVIDER: "knowlarity" })?.name).toBe("knowlarity");
  });
});
