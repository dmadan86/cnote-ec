import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { isOptIn, isOptOut, verifyChallenge, verifySignature, signBody, parseWebhook, isWithinWindow, windowUntilFor, extendWindow, parseLocation } from "../src";
import { metaCloudProvider, mockProvider, WhatsAppError } from "../src";
import { audioMsg, buttonMsg, imageMsg, listMsg, statusMsg, stickerMsg, textMsg } from "./fixtures";

describe("signature", () => {
  const secret = "s3cret";
  const body = JSON.stringify(textMsg("919876500001", "wamid.1", "hi"));
  const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  it("accepts a valid signature and rejects tampering, missing, malformed and wrong secret", () => {
    expect(verifySignature(body, sig, secret)).toBe(true);
    expect(verifySignature(body + " ", sig, secret)).toBe(false);
    expect(verifySignature(body, undefined, secret)).toBe(false);
    expect(verifySignature(body, "sha256=zz", secret)).toBe(false);
    expect(verifySignature(body, sig, "other")).toBe(false);
    expect(verifySignature(body, sig, undefined)).toBe(false);
    expect(verifySignature(Buffer.from(body), signBody(body, secret), secret)).toBe(true);
  });
  it("verifies the hub challenge", () => {
    expect(verifyChallenge({ mode: "subscribe", token: "tok", challenge: "42" }, "tok")).toBe("42");
    expect(verifyChallenge({ mode: "subscribe", token: "bad", challenge: "42" }, "tok")).toBeNull();
    expect(verifyChallenge({ mode: "subscribe", token: "tok", challenge: "42" }, undefined)).toBeNull();
    expect(verifyChallenge({ mode: "x", token: "tok", challenge: "42" }, "tok")).toBeNull();
  });
});

describe("webhook parsing", () => {
  const wa = "919876500001";
  it("parses each message type", () => {
    expect(parseWebhook(textMsg(wa, "a", "Hello")).messages[0]).toMatchObject({ id: "a", from: wa, profileName: "Ravi", content: { type: "text", text: "Hello" } });
    expect(parseWebhook(imageMsg(wa, "b")).messages[0]!.content).toMatchObject({ type: "image", mediaId: "MEDIA1", mime: "image/jpeg", caption: "pipe" });
    expect(parseWebhook(audioMsg(wa, "c")).messages[0]!.content).toMatchObject({ type: "audio", voice: true });
    expect(parseWebhook(buttonMsg(wa, "d", "consent_yes")).messages[0]!.content).toMatchObject({ type: "button", id: "consent_yes" });
    expect(parseWebhook(listMsg(wa, "e", "lang_ta")).messages[0]!.content).toMatchObject({ type: "button", id: "lang_ta" });
    expect(parseWebhook(stickerMsg(wa, "f")).messages[0]!.content).toMatchObject({ type: "unsupported", original: "sticker" });
  });
  it("parses template quick-reply buttons and malformed content safely", () => {
    const v = { messages: [{ from: wa, id: "g", timestamp: "1", type: "button", button: { payload: "yes", text: "Yes" } }, { from: wa, id: "h", type: "text" }, { from: wa, id: "i", type: "image", image: {} }, { from: wa, id: "j", type: "audio", audio: {} }, { from: wa, id: "k", type: "interactive", interactive: {} }, { from: wa, id: "l", type: "button", button: {} }, { id: "nofrom" }] };
    const r = parseWebhook({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: v }, { field: "other", value: {} }, "junk"] }, "x"] });
    expect(r.messages.map((m) => m.content.type)).toEqual(["button", "unsupported", "unsupported", "unsupported", "unsupported", "unsupported"]);
  });
  it("parses statuses and ignores garbage", () => {
    const r = parseWebhook(statusMsg("wamid.o", "failed", [{ code: 131047, title: "Re-engagement message" }]));
    expect(r.statuses[0]).toMatchObject({ id: "wamid.o", status: "failed", error: { code: 131047 } });
    expect(parseWebhook(statusMsg("wamid.o", "weird")).statuses).toEqual([]);
    expect(parseWebhook(null)).toEqual({ messages: [], statuses: [] });
    expect(parseWebhook({ object: "page" })).toEqual({ messages: [], statuses: [] });
  });
});

describe("24h window (fake clock)", () => {
  it("opens for 24h after the customer message and only extends", () => {
    const t0 = new Date("2026-01-01T10:00:00Z");
    const until = windowUntilFor(t0);
    expect(until.toISOString()).toBe("2026-01-02T10:00:00.000Z");
    expect(isWithinWindow(until, new Date("2026-01-02T09:59:59Z"))).toBe(true);
    expect(isWithinWindow(until, new Date("2026-01-02T10:00:00Z"))).toBe(false);
    expect(isWithinWindow(null)).toBe(false);
    expect(extendWindow(until, new Date("2026-01-01T09:00:00Z"))).toBe(until);
    expect(extendWindow(null, t0).getTime()).toBe(until.getTime());
    expect(extendWindow(until, new Date("2026-01-01T12:00:00Z")).toISOString()).toBe("2026-01-02T12:00:00.000Z");
  });
});

describe("opt-out keywords", () => {
  it("matches English and Hindi exact phrases only", () => {
    for (const t of ["STOP", " stop! ", "Unsubscribe", "opt out", "बंद", "बंद करो", "band karo", "रुको"]) expect(isOptOut(t), t).toBe(true);
    for (const t of ["please stop calling me a liar", "stopper", "hello", ""]) expect(isOptOut(t), t).toBe(false);
    expect(isOptIn("START")).toBe(true);
    expect(isOptIn("शुरू")).toBe(true);
    expect(isOptIn("hello")).toBe(false);
  });
});

describe("location parsing", () => {
  it("extracts pincode and city", () => {
    expect(parseLocation("Ludhiana 141003")).toEqual({ city: "Ludhiana", pincode: "141003" });
    expect(parseLocation("141003")).toEqual({ city: null, pincode: "141003" });
    expect(parseLocation("Navi Mumbai, 400703.")).toEqual({ city: "Navi Mumbai", pincode: "400703" });
    expect(parseLocation("Delhi")).toBeNull();
    expect(parseLocation("012345")).toBeNull();
    expect(parseLocation("1234567")).toBeNull();
  });
});

describe("meta_cloud provider", () => {
  const cfg = { phoneNumberId: "PN", accessToken: "T", appSecret: "s", verifyToken: "v", apiVersion: "v23.0", graphUrl: "https://graph.test" };
  const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  it("sends text, template, buttons and list with the right payloads", async () => {
    const f = vi.fn(async () => ok({ messages: [{ id: "wamid.9" }] }));
    const p = metaCloudProvider(cfg, f as never);
    expect(await p.sendText("919", "hi")).toEqual({ providerId: "wamid.9" });
    await p.sendTemplate("919", { name: "tpl", language: "en", bodyParams: ["a"] });
    await p.sendTemplate("919", { name: "tpl2", language: "hi" });
    await p.sendInteractive("919", { body: "b", buttons: [{ id: "x", title: "A very long button title indeed" }] });
    await p.sendInteractive("919", { body: "b", list: { button: "Choose", rows: [{ id: "r", title: "Row", description: "d" }] } });
    await p.markRead("wamid.in");
    const bodies = (f.mock.calls as unknown as [string, RequestInit][]).map(([, i]) => JSON.parse(i.body as string));
    expect(bodies[0]).toMatchObject({ messaging_product: "whatsapp", to: "919", type: "text" });
    expect(bodies[1].template.components[0].parameters[0]).toEqual({ type: "text", text: "a" });
    expect(bodies[2].template.components).toBeUndefined();
    expect(bodies[3].interactive.action.buttons[0].reply.title.length).toBeLessThanOrEqual(20);
    expect(bodies[4].interactive.type).toBe("list");
    expect(bodies[5]).toMatchObject({ status: "read", message_id: "wamid.in" });
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe("https://graph.test/v23.0/PN/messages");
  });
  it("maps errors: permanent 4xx, transient 5xx, network, missing id", async () => {
    const mk = (res: () => Promise<Response>) => metaCloudProvider(cfg, res as never);
    await expect(mk(async () => new Response(JSON.stringify({ error: { code: 131047, message: "window" } }), { status: 400 })).sendText("1", "x")).rejects.toMatchObject({ permanent: true, code: 131047 });
    await expect(mk(async () => new Response("{}", { status: 503 })).sendText("1", "x")).rejects.toMatchObject({ permanent: false });
    await expect(mk(async () => { throw new Error("net"); }).sendText("1", "x")).rejects.toBeInstanceOf(WhatsAppError);
    await expect(mk(async () => ok({})).sendText("1", "x")).rejects.toMatchObject({ status: 502 });
  });
  it("downloads media in two steps, sending the bearer on both", async () => {
    const f = vi.fn(async (url: string) =>
      url.includes("lookaside") ? new Response(new Uint8Array([1, 2, 3]), { status: 200 }) : ok({ url: "https://lookaside.test/m", mime_type: "image/png", file_size: 3 }),
    );
    const r = await metaCloudProvider(cfg, f as never).downloadMedia("M1");
    expect(r).toEqual({ bytes: new Uint8Array([1, 2, 3]), mime: "image/png" });
    for (const [, init] of f.mock.calls as unknown as [string, RequestInit][]) expect((init.headers as Record<string, string>).authorization).toBe("Bearer T");
    await expect(metaCloudProvider(cfg, (async () => ok({ mime_type: "x" })) as never).downloadMedia("M")).rejects.toMatchObject({ status: 502 });
    await expect(metaCloudProvider(cfg, (async () => ok({ url: "u", file_size: 99_000_000 })) as never).downloadMedia("M")).rejects.toMatchObject({ status: 413 });
  });
  it("mock provider records sends and can fail", async () => {
    const m = mockProvider();
    await m.sendText("1", "a");
    await m.sendTemplate("1", { name: "t", language: "en" });
    await m.sendInteractive("1", { body: "b" });
    await m.markRead("w");
    expect(m.sent.map((s) => s.kind)).toEqual(["text", "template", "interactive"]);
    m.failNext = 1;
    await expect(m.sendText("1", "x")).rejects.toThrow();
    await expect(m.downloadMedia("nope")).rejects.toThrow();
    m.reset();
    expect(m.sent).toEqual([]);
  });
});
