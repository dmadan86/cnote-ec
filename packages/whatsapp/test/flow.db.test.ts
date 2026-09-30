import { randomUUID } from "node:crypto";
import { MemoryJobQueue, setJobQueue } from "@cnote/core";
import { prisma } from "@cnote/db";
import { hashPhone } from "@cnote/identity";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleInboundJob, handleWebhook, mockProvider, purgeWhatsAppMessages, sendToPhone, setWhatsAppPorts, setWhatsAppProvider, signBody, worker, listContacts, getContactMessages, resetContact } from "../src";
import { HI_DEFAULTS } from "../src";
import { renderCopy } from "../src/copy";
import { audioMsg, buttonMsg, imageMsg, statusMsg, stickerMsg, textMsg } from "./fixtures";

const SECRET = "app-secret";
process.env.WHATSAPP_APP_SECRET = SECRET;
const provider = mockProvider();
const queue = new MemoryJobQueue();
const phones: string[] = [];
const newWa = () => {
  const wa = `9199${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  phones.push(wa);
  return wa;
};
const calls = { person: 0, consent: [] as unknown[][], business: 0, draft: [] as unknown[], submit: 0 };
let n = 0;
const P1 = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const PX = "00000000-0000-4000-8000-0000000000ff";
const id = () => `wamid.test.${randomUUID()}.${n++}`;

beforeEach(() => {
  provider.reset();
  provider.media.set("MEDIA1", { bytes: new Uint8Array([1]), mime: "image/jpeg" });
  provider.media.set("MEDIA2", { bytes: new Uint8Array([2]), mime: "audio/ogg" });
  setWhatsAppProvider(provider);
  setJobQueue(queue);
  Object.assign(calls, { person: 0, consent: [], business: 0, draft: [], submit: 0 });
  setWhatsAppPorts({
    findOrCreatePerson: async () => ({ personId: P1(++calls.person) }),
    recordConsent: async (...a) => void calls.consent.push(a),
    createSellerBusiness: async () => ({ businessId: `biz-${++calls.business}` }),
    draftFromMedia: async (b, p, m, l) => {
      expect(p).toMatch(/^[0-9a-f-]{36}$/); // the provisioned person drafts the listing
      calls.draft.push([b, m.images.length, !!m.audio, l]);
      return { listingId: "listing-1", title: "Steel pipe", categoryName: "Steel", pricePaise: 25000, priceUnit: "kg", moq: 100, moqUnit: "kg" };
    },
    submitListing: async () => void calls.submit++,
  });
});

afterAll(async () => {
  const hashes = phones.map((p) => hashPhone(`+${p}`));
  await prisma.whatsAppContact.deleteMany({ where: { phoneHash: { in: hashes } } });
  setWhatsAppPorts(undefined);
  setWhatsAppProvider(undefined);
  setJobQueue(undefined);
});

/** Delivers a webhook body through signature check + queue + consumer, like production. */
async function deliver(body: unknown) {
  const raw = JSON.stringify(body);
  const res = await handleWebhook(raw, { "x-hub-signature-256": signBody(raw, SECRET) }, { queue });
  const topic = "whatsapp.inbound" as const;
  await queue.promoteDelayed(topic);
  while ((await queue.consume(topic, "t", "c", (m) => handleInboundJob(m))) > 0);
  return res;
}
const contactOf = (wa: string) => prisma.whatsAppContact.findUniqueOrThrow({ where: { phoneHash: hashPhone(`+${wa}`) } });
const lastText = () => provider.sent.at(-1)?.text ?? "";

describe("webhook intake", () => {
  it("rejects bad signatures and bad JSON, accepts valid, dedupes replays", async () => {
    const wa = newWa();
    const body = textMsg(wa, id(), "hi");
    const raw = JSON.stringify(body);
    expect((await handleWebhook(raw, { "x-hub-signature-256": "sha256=" + "0".repeat(64) }, { queue })).status).toBe(401);
    expect((await handleWebhook(raw, {}, { queue })).status).toBe(401);
    const badJson = "{nope";
    expect((await handleWebhook(badJson, { "x-hub-signature-256": signBody(badJson, SECRET) }, { queue })).status).toBe(400);
    const h = new Headers({ "x-hub-signature-256": signBody(raw, SECRET) });
    expect(await handleWebhook(raw, h, { queue })).toEqual({ status: 200, enqueued: 1 });
    expect((await handleWebhook(raw, h, { queue })).enqueued).toBe(0); // replay dropped by dedupeKey
    await queue.promoteDelayed("whatsapp.inbound");
    await queue.consume("whatsapp.inbound", "t", "c", (m) => handleInboundJob(m));
  });
  it("is idempotent by wamid at the consumer even if the queue redelivers", async () => {
    const wa = newWa();
    const mid = id();
    const msg = { kind: "message" as const, message: { id: mid, from: wa, timestamp: new Date().toISOString(), content: { type: "text" as const, text: "hi" } } };
    const qm = { id: "1", topic: "whatsapp.inbound", payload: msg, attempt: 1, maxAttempts: 5, enqueuedAt: "" };
    await handleInboundJob(qm);
    const sent = provider.sent.length;
    await handleInboundJob(qm);
    expect(provider.sent.length).toBe(sent);
    expect(await prisma.whatsAppMessage.count({ where: { providerId: mid } })).toBe(1);
  });
});

describe("seller onboarding end to end (mock provider, mocked identity/catalogue)", () => {
  it("runs the whole flow in Hindi and stores no text before consent", async () => {
    const wa = newWa();
    await deliver(textMsg(wa, id(), "Namaste"));
    expect(provider.sent.at(-1)!.interactive!.buttons!.map((b) => b.id)).toEqual(["lang_en", "lang_hi", "lang_more"]);
    let c = await contactOf(wa);
    expect(await prisma.whatsAppMessage.findMany({ where: { contactId: c.id, direction: "in" } })).toMatchObject([{ body: null }]);

    await deliver(buttonMsg(wa, id(), "lang_hi"));
    expect(lastText()).toContain("सहमत");
    expect(calls.person).toBe(0); // nothing provisioned before consent
    await deliver(buttonMsg(wa, id(), "consent_yes"));
    await deliver(textMsg(wa, id(), "Sharma Steel"));
    expect(lastText()).toContain("Sharma Steel");
    await deliver(textMsg(wa, id(), "Ludhiana 141003"));
    expect(calls.person).toBe(1);
    expect(calls.consent[0]).toEqual([P1(1), "matching", true, "whatsapp_onboarding"]);
    expect(calls.business).toBe(1);
    expect(lastText()).toContain("फ़ोटो");
    await deliver(imageMsg(wa, id()));
    await deliver(audioMsg(wa, id()));
    await deliver(buttonMsg(wa, id(), "done"));
    expect(calls.draft).toEqual([["biz-1", 1, true, "hi"]]);
    expect(provider.sent.at(-1)!.interactive!.body).toContain("Steel pipe");
    expect(provider.sent.at(-1)!.interactive!.buttons!.map((b) => b.id)).toEqual(["submit", "edit"]);
    await deliver(buttonMsg(wa, id(), "edit"));
    expect(lastText()).toContain("/listings/listing-1/edit");
    await deliver(buttonMsg(wa, id(), "submit"));
    expect(calls.submit).toBe(1);
    expect(lastText()).toContain("/listings");

    c = await contactOf(wa);
    expect(c).toMatchObject({ personId: P1(1), language: "hi" });
    expect((c.state as { step: string }).step).toBe("done");
    expect(c.windowUntil!.getTime()).toBeGreaterThan(0);
    expect(provider.read.length).toBeGreaterThan(5);
    const rows = await getContactMessages(c.id);
    expect(rows.some((r) => r.direction === "out" && r.status === "sent")).toBe(true);
    expect((await listContacts()).find((r) => r.id === c.id)).toMatchObject({ step: "done", consented: true, ref: c.phoneHash.slice(0, 8) });
    expect((await listContacts({ step: "nothing" })).length).toBe(0);
    await resetContact(c.id);
    expect((await listContacts()).find((r) => r.id === c.id)!.step).toBeNull();
  });

  it("recovers from provisioning and draft failures and unsupported messages", async () => {
    const wa = newWa();
    setWhatsAppPorts({ findOrCreatePerson: async () => { throw new Error("db down"); } });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const m of [textMsg(wa, id(), "hi"), buttonMsg(wa, id(), "lang_en"), buttonMsg(wa, id(), "consent_yes"), textMsg(wa, id(), "Acme"), textMsg(wa, id(), "Pune 411001")]) await deliver(m);
    expect(lastText()).toContain("went wrong");
    expect((await contactOf(wa)).state).toMatchObject({ step: "location" });
    await deliver(stickerMsg(wa, id()));
    expect(lastText()).toContain("pincode");
    vi.restoreAllMocks();
  });

  it("marks failed outbound sends without failing the job", async () => {
    const wa = newWa();
    provider.failNext = 10;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await deliver(textMsg(wa, id(), "hi"));
    const c = await contactOf(wa);
    expect(await prisma.whatsAppMessage.count({ where: { contactId: c.id, direction: "out", status: "failed" } })).toBe(1);
    expect((await listContacts()).find((r) => r.id === c.id)!.failedSends).toBe(1);
    vi.restoreAllMocks();
  });
});

describe("opt-out, statuses, window, outbound helper, retention", () => {
  it("STOP opts out, silences the bot, START opts back in; marketing consent is withdrawn", async () => {
    const wa = newWa();
    await deliver(textMsg(wa, id(), "hi"));
    await prisma.whatsAppContact.update({ where: { phoneHash: hashPhone(`+${wa}`) }, data: { personId: PX } });
    provider.reset();
    await deliver(textMsg(wa, id(), "STOP"));
    expect(lastText()).toContain("not get any more");
    expect((await contactOf(wa)).optedOutAt).not.toBeNull();
    expect(calls.consent.at(-1)).toEqual([PX, "marketing", false, "whatsapp_stop"]);
    provider.reset();
    await deliver(textMsg(wa, id(), "hello?"));
    expect(provider.sent).toHaveLength(0);
    await deliver(textMsg(wa, id(), "बंद करो"));
    await deliver(textMsg(wa, id(), "START"));
    expect(lastText()).toContain("Welcome back");
    expect((await contactOf(wa)).optedOutAt).toBeNull();
  });

  it("applies status updates monotonically and ignores unknown ids", async () => {
    const wa = newWa();
    await deliver(textMsg(wa, id(), "hi"));
    const out = await prisma.whatsAppMessage.findFirstOrThrow({ where: { contact: { phoneHash: hashPhone(`+${wa}`) }, direction: "out" } });
    await deliver(statusMsg(out.providerId!, "read"));
    await deliver(statusMsg(out.providerId!, "delivered"));
    expect((await prisma.whatsAppMessage.findUniqueOrThrow({ where: { id: out.id } })).status).toBe("read");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await deliver(statusMsg(out.providerId!, "failed", [{ code: 131026, title: "Undeliverable" }]));
    expect((await prisma.whatsAppMessage.findUniqueOrThrow({ where: { id: out.id } })).status).toBe("read"); // read is final
    await deliver(statusMsg("wamid.unknown", "sent"));
    vi.restoreAllMocks();
  });

  it("sendToPhone: text inside the window, template outside, respects opt-out and marketing consent", async () => {
    const wa = newWa();
    const phone = `+${wa}`;
    const tpl = { name: "cnote_lead_alert", language: "en", bodyParams: ["Ravi"], category: "utility" as const };
    // unknown contact: no window -> template only
    expect(await sendToPhone({ phone, text: "hello", template: tpl })).toMatchObject({ sent: true, via: "template" });
    expect(await sendToPhone({ phone, text: "hello" })).toEqual({ sent: false, reason: "outside_window" });
    expect(await sendToPhone({ phone, template: { ...tpl, category: "marketing" } })).toEqual({ sent: false, reason: "no_consent" });
    expect(await sendToPhone({ phone, template: { ...tpl, category: "marketing" }, marketingConsent: true })).toMatchObject({ sent: true });
    const c = await contactOf(wa);
    const cost = await prisma.whatsAppMessage.findMany({ where: { contactId: c.id, direction: "out" }, orderBy: { createdAt: "asc" } });
    expect(cost.map((m) => m.costPaise)).toEqual([12, 87]);
    await prisma.whatsAppContact.update({ where: { id: c.id }, data: { windowUntil: new Date(Date.now() + 3600_000) } });
    expect(await sendToPhone({ phone, text: "inside window" })).toMatchObject({ sent: true, via: "text" });
    expect(await sendToPhone({ phone, interactive: { body: "pick", buttons: [{ id: "a", title: "A" }] } })).toMatchObject({ via: "interactive" });
    provider.failNext = 5;
    expect(await sendToPhone({ phone, text: "x" })).toEqual({ sent: false, reason: "send_failed" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await prisma.whatsAppContact.update({ where: { id: c.id }, data: { optedOutAt: new Date() } });
    expect(await sendToPhone({ phone, text: "x", template: tpl })).toEqual({ sent: false, reason: "opted_out" });
    vi.restoreAllMocks();
  });

  it("purges bodies and media keys past retention only", async () => {
    const wa = newWa();
    await deliver(textMsg(wa, id(), "hi"));
    const c = await contactOf(wa);
    const old = await prisma.whatsAppMessage.create({ data: { contactId: c.id, direction: "out", kind: "text", body: "old", mediaKey: "listings/x.jpg", createdAt: new Date(Date.now() - 40 * 86400_000) } });
    const fresh = await prisma.whatsAppMessage.create({ data: { contactId: c.id, direction: "out", kind: "text", body: "new" } });
    expect(await purgeWhatsAppMessages()).toBeGreaterThanOrEqual(1);
    expect(await prisma.whatsAppMessage.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ body: null, mediaKey: null });
    expect((await prisma.whatsAppMessage.findUniqueOrThrow({ where: { id: fresh.id } })).body).toBe("new");
  });
});

describe("copy + worker", () => {
  it("renders English defaults, Hindi in-code defaults, and other languages fall back to English", async () => {
    expect(await renderCopy("ask_location", "en", { businessName: "Acme" })).toContain("Acme");
    expect(await renderCopy("ask_location", "hi", { businessName: "Acme" })).toContain("पिनकोड");
    expect(await renderCopy("ask_business_name", "ta")).toContain("business name");
    expect(Object.keys(HI_DEFAULTS).every((k) => k.startsWith("whatsapp."))).toBe(true);
  });
  it("worker exposes the queue consumer and purge job", async () => {
    expect(worker.queues![0]!.topic).toBe("whatsapp.inbound");
    expect(worker.jobs[0]!.name).toBe("whatsapp.purge-messages");
    await worker.jobs[0]!.run();
  });
});
