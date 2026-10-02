import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rateLimit: vi.fn(async () => true),
  transcribe: vi.fn(),
  derive: vi.fn(),
  verifyHuman: vi.fn(async () => ({ ok: true })),
  getSponsoredSlots: vi.fn(async () => []),
  cookies: new Map<string, string>(),
}));

vi.mock("@cnote/core", async (orig) => ({ ...(await orig<typeof import("@cnote/core")>()), rateLimit: h.rateLimit }));
vi.mock("@cnote/ai", () => ({ transcribe: h.transcribe, deriveImageSearch: h.derive, PHOTO_CATEGORY_CONFIDENCE: 0.6 }));
vi.mock("@cnote/security", () => ({ verifyHuman: h.verifyHuman }));
vi.mock("@cnote/ads", () => ({ isAdsEnabled: () => true, getSponsoredSlots: h.getSponsoredSlots, attributeEnquiry: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (h.cookies.has(n) ? { value: h.cookies.get(n) } : undefined) }) }));
vi.mock("@/features/search/data", () => ({ loadCategories: async () => [{ slug: "apparel", name: "Apparel" }], safe: async (_l: string, fn: () => unknown) => fn() }));
vi.mock("next-intl", () => ({ useTranslations: () => (k: string) => k, useLocale: () => "hi" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const { buyerLocation, stateFromPincode, validPincode } = await import("@/features/search/geo");
const { fitWithin, HOLD_MS, isHold, langHint, photoSearchHref, pickRecorderMime } = await import("@/features/search/voice-photo");
const { asLang, clientIp, tooLarge } = await import("@/features/search/api-guard");
const voice = await import("@/app/api/search/voice/route");
const image = await import("@/app/api/search/image/route");
const { loadSponsoredForResults } = await import("@/features/ads/slots");
const { SearchTools } = await import("@/features/search/search-tools");
const { CONSENT_POLICY_VERSION, serializeConsent } = await import("@/features/consent/state");
const marketingConsent = (marketing: boolean) => serializeConsent({ version: CONSENT_POLICY_VERSION, id: "9".repeat(32), analytics: false, marketing, functional: false, gpc: false, at: Math.floor(Date.now() / 1000) - 5 });
const { solidJpeg } = await import("@cnote/media");

const post = (path: string, fd: FormData, headers: Record<string, string> = {}) => new NextRequest(`http://x.test${path}`, { method: "POST", body: fd, headers });
const audio = (bytes = 2000, type = "audio/webm;codecs=opus") => new File([new Uint8Array(bytes).fill(1)], "a.webm", { type });

beforeEach(() => {
  vi.clearAllMocks();
  h.rateLimit.mockResolvedValue(true);
  h.verifyHuman.mockResolvedValue({ ok: true });
  h.cookies.clear();
});

describe("buyer geo (ads geo-targeting gap)", () => {
  it("derives the state from PIN prefixes, with 3-digit exceptions", () => {
    expect(stateFromPincode("400069")).toBe("Maharashtra");
    expect(stateFromPincode("641604")).toBe("Tamil Nadu");
    expect(stateFromPincode("110020")).toBe("Delhi");
    expect(stateFromPincode("560058")).toBe("Karnataka");
    expect(stateFromPincode("244001")).toBe("Uttar Pradesh");
    expect(stateFromPincode("248001")).toBe("Uttarakhand");
    expect(stateFromPincode("403001")).toBe("Goa");
    expect(stateFromPincode("500001")).toBe("Telangana");
    expect(stateFromPincode("834001")).toBe("Jharkhand");
    expect(stateFromPincode("999999")).toBeNull();
  });
  it("rejects malformed pincodes and never throws", () => {
    for (const bad of ["", "12345", "0123456", "abcdef", "012345", null, undefined]) {
      expect(validPincode(bad)).toBeNull();
      expect(buyerLocation(bad)).toEqual({ buyerPincode: null, buyerState: null });
    }
    expect(buyerLocation("400069")).toEqual({ buyerPincode: "400069", buyerState: "Maharashtra" });
  });
  it("loadSponsoredForResults passes the Deliver-to cookie as pincode + state", async () => {
    h.cookies.set("cnote_pincode", "641604");
    h.cookies.set("cnote_vid", "vid1");
    h.cookies.set("cnote_consent", marketingConsent(true));
    await loadSponsoredForResults({ query: "yarn", surface: "search", organicListingIds: ["a"] });
    expect(h.getSponsoredSlots).toHaveBeenCalledWith(expect.objectContaining({ query: "yarn", visitorId: "vid1", buyerPincode: "641604", buyerState: "Tamil Nadu" }));
  });
  it("does not read the visitor id cookie without marketing consent (cnote_vid is marketing storage)", async () => {
    h.getSponsoredSlots.mockClear();
    h.cookies.set("cnote_vid", "vid1");
    for (const consent of [undefined, marketingConsent(false)]) {
      if (consent) h.cookies.set("cnote_consent", consent);
      else h.cookies.delete("cnote_consent");
      await loadSponsoredForResults({ query: "yarn", surface: "search", organicListingIds: ["a"] });
      expect(h.getSponsoredSlots).toHaveBeenLastCalledWith(expect.objectContaining({ visitorId: null }));
    }
    h.cookies.delete("cnote_consent");
  });
  it("without a valid cookie the location is explicitly unknown", async () => {
    h.cookies.set("cnote_pincode", "junk");
    await loadSponsoredForResults({ query: "yarn", surface: "search", organicListingIds: [] });
    expect(h.getSponsoredSlots).toHaveBeenCalledWith(expect.objectContaining({ buyerPincode: null, buyerState: null }));
  });
});

describe("voice/photo helpers", () => {
  it("picks the first supported recorder type and survives isTypeSupported throwing", () => {
    expect(pickRecorderMime((m) => m === "audio/mp4")).toBe("audio/mp4");
    expect(pickRecorderMime(() => false)).toBeUndefined();
    expect(pickRecorderMime((m) => { if (m.includes("webm")) throw new Error("x"); return m === "audio/ogg;codecs=opus"; })).toBe("audio/ogg;codecs=opus");
  });
  it("press-and-hold vs tap, language hint, downscale and URL", () => {
    expect(isHold(0, HOLD_MS)).toBe(true);
    expect(isHold(0, HOLD_MS - 1)).toBe(false);
    expect(langHint("kn")).toBe("kn");
    expect(langHint("fr")).toBe("en");
    expect(fitWithin(4000, 2000)).toEqual({ width: 1280, height: 640 });
    expect(fitWithin(300, 200)).toEqual({ width: 300, height: 200 });
    expect(fitWithin(0, 0)).toEqual({ width: 1, height: 1 });
    expect(photoSearchHref({ query: "red box", category: "pkg" })).toBe("/search?q=red+box&via=photo&tab=products&category=pkg");
    expect(photoSearchHref({ query: "x" })).not.toContain("category");
  });
  it("api guard helpers", () => {
    expect(asLang("ta")).toBe("ta");
    expect(asLang("zz")).toBe("en");
    expect(asLang(null)).toBe("en");
    expect(clientIp(new NextRequest("http://x", { headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" } }))).toBe("2.2.2.2"); // never the spoofable first hop
    expect(clientIp(new NextRequest("http://x", { headers: { "x-real-ip": "3.3.3.3" } }))).toBe("3.3.3.3");
    expect(clientIp(new NextRequest("http://x"))).toBe("unknown");
    expect(tooLarge(new NextRequest("http://x", { headers: { "content-length": "999" } }), 100)).toBe(true);
    expect(tooLarge(new NextRequest("http://x"), 100)).toBe(false);
  });
});

describe("POST /api/search/voice", () => {
  const form = (over: Record<string, string | File> = {}) => {
    const fd = new FormData();
    fd.set("audio", audio());
    fd.set("consent", "1");
    fd.set("lang", "hi");
    for (const [k, v] of Object.entries(over)) fd.set(k, v);
    return fd;
  };
  it("transcribes, sends the language hint, never stores, and is not cacheable", async () => {
    h.transcribe.mockResolvedValue({ text: "  कपास   का कपड़ा ", language: "hi", confidence: 0.8 });
    const res = await voice.POST(post("/api/search/voice", form()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "कपास का कपड़ा", language: "hi", confidence: 0.8 });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const [input, subject] = h.transcribe.mock.calls[0]!;
    expect(input.languageHint).toBe("hi");
    expect(input.audio.mimeType).toBe("audio/webm;codecs=opus");
    expect(subject.type).toBe("voice_note");
  });
  it("requires consent, audio, and a sane size", async () => {
    const noConsent = form();
    noConsent.delete("consent");
    expect((await voice.POST(post("/api/search/voice", noConsent))).status).toBe(400);
    expect(await (await voice.POST(post("/api/search/voice", noConsent))).json()).toEqual({ error: "consent_required" });
    const none = form();
    none.delete("audio");
    expect((await voice.POST(post("/api/search/voice", none))).status).toBe(400);
    expect((await voice.POST(post("/api/search/voice", form({ audio: audio(0) })))).status).toBe(400);
    expect((await voice.POST(post("/api/search/voice", form({ audio: audio(voice.MAX_VOICE_BYTES + 1) })))).status).toBe(413);
    expect((await voice.POST(post("/api/search/voice", form(), { "content-length": String(voice.MAX_VOICE_BYTES * 3) }))).status).toBe(413);
    expect(h.transcribe).not.toHaveBeenCalled();
  });
  it("rate limits (429) and fails closed when the limiter is down (503)", async () => {
    h.rateLimit.mockResolvedValueOnce(false);
    expect((await voice.POST(post("/api/search/voice", form()))).status).toBe(429);
    h.rateLimit.mockRejectedValueOnce(new Error("redis down"));
    expect((await voice.POST(post("/api/search/voice", form()))).status).toBe(503);
    expect(h.transcribe).not.toHaveBeenCalled();
  });
  it("maps validation errors to 400 and provider failures to 502 without leaking details", async () => {
    const { DomainError } = await import("@cnote/core");
    h.transcribe.mockRejectedValueOnce(new DomainError("validation", "bad audio"));
    expect((await voice.POST(post("/api/search/voice", form()))).status).toBe(400);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.transcribe.mockRejectedValueOnce(new Error("vendor secret sk-123"));
    const res = await voice.POST(post("/api/search/voice", form()));
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("sk-123");
    err.mockRestore();
  });
  it("rejects a non-multipart body", async () => {
    const res = await voice.POST(new NextRequest("http://x.test/api/search/voice", { method: "POST", body: "nope", headers: { "content-type": "text/plain" } }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/search/image", () => {
  const jpeg = async (w = 400, hgt = 300) => new File([Buffer.from(await solidJpeg(w, hgt))], "p.jpg", { type: "image/jpeg" });
  const form = async (over: Record<string, string | File> = {}) => {
    const fd = new FormData();
    fd.set("image", await jpeg());
    fd.set("lang", "en");
    for (const [k, v] of Object.entries(over)) fd.set(k, v);
    return fd;
  };
  it("validates, re-encodes in memory, derives the query and returns category only when trusted", async () => {
    h.derive.mockResolvedValue({ query: "red box", keywords: ["red", "box"], categorySlug: "apparel", confidence: 0.9, decisionId: "d", needsReview: false });
    const res = await image.POST(post("/api/search/image", await form()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ query: "red box", keywords: ["red", "box"], category: "apparel", confidence: 0.9 });
    const [input] = h.derive.mock.calls[0]!;
    expect(input.images).toHaveLength(1);
    expect(input.images[0].mimeType).toBe("image/jpeg");
    expect(input.categories).toEqual([{ slug: "apparel", name: "Apparel", attributeSchema: null }]);
    h.derive.mockResolvedValue({ query: "box", keywords: ["box"], categorySlug: "apparel", confidence: 0.4, decisionId: "d", needsReview: true });
    expect((await (await image.POST(post("/api/search/image", await form()))).json()).category).toBeNull();
  });
  it("the bytes sent to the vendor carry no Exif marker (re-encoded in memory)", async () => {
    h.derive.mockImplementation(async (i: { images: { bytes: Uint8Array }[] }) => ({ query: "x", keywords: ["x"], categorySlug: null, confidence: 1, decisionId: "d", needsReview: false, sent: i.images[0]!.bytes }));
    await image.POST(post("/api/search/image", await form()));
    const sent = h.derive.mock.calls[0]![0].images[0].bytes as Uint8Array;
    expect(Buffer.from(sent).includes(Buffer.from("Exif"))).toBe(false);
  });
  it("rejects non-images, tiny images, missing files and failed human checks before any vendor call", async () => {
    const bad = new File([new Uint8Array(500).fill(7)], "x.jpg", { type: "image/jpeg" });
    expect((await image.POST(post("/api/search/image", await form({ image: bad })))).status).toBe(400);
    expect((await image.POST(post("/api/search/image", await form({ image: await jpeg(50, 50) })))).status).toBe(400);
    const none = await form();
    none.delete("image");
    expect((await image.POST(post("/api/search/image", none))).status).toBe(400);
    h.verifyHuman.mockResolvedValueOnce({ ok: false, reason: "missing_token" } as never);
    expect((await image.POST(post("/api/search/image", await form()))).status).toBe(403);
    expect((await image.POST(post("/api/search/image", await form(), { "content-length": String(image.MAX_PHOTO_BYTES * 3) }))).status).toBe(413);
    expect(h.derive).not.toHaveBeenCalled();
  });
  it("forwards the Turnstile token and client IP to the verifier; rate limits", async () => {
    h.derive.mockResolvedValue({ query: "", keywords: [], categorySlug: null, confidence: 0.1, decisionId: "d", needsReview: true });
    const res = await image.POST(post("/api/search/image", await form({ "cf-turnstile-response": "tok" }), { "x-forwarded-for": "9.9.9.9" }));
    expect((await res.json()).query).toBe("");
    expect(h.verifyHuman).toHaveBeenCalledWith("tok", "9.9.9.9");
    h.rateLimit.mockResolvedValueOnce(false);
    expect((await image.POST(post("/api/search/image", await form()))).status).toBe(429);
  });
  it("maps vendor failures to 502 and non-string tokens to a failed check", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.derive.mockRejectedValueOnce(new Error("vendor down"));
    expect((await image.POST(post("/api/search/image", await form()))).status).toBe(502);
    const { DomainError } = await import("@cnote/core");
    h.derive.mockRejectedValueOnce(new DomainError("validation", "exif"));
    expect((await image.POST(post("/api/search/image", await form()))).status).toBe(400);
    err.mockRestore();
    await image.POST(post("/api/search/image", await form({ "cf-turnstile-response": new File(["x"], "t") })));
    expect(h.verifyHuman).toHaveBeenLastCalledWith(null, "unknown");
  });
  it("rejects a non-multipart body", async () => {
    const res = await image.POST(new NextRequest("http://x.test/api/search/image", { method: "POST", body: "nope", headers: { "content-type": "text/plain" } }));
    expect(res.status).toBe(400);
  });
});

describe("SearchTools (server render = no JS)", () => {
  it("renders hidden so the plain GET form works without JavaScript, with a polite live region", () => {
    const html = renderToStaticMarkup(<SearchTools inputId="search-q" />);
    expect(html).toMatch(/<div hidden="" class="flex gap-2" role="group" aria-label="toolsAria">/);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("<button"); // no controls until the browser proves it can record / upload
  });
});
