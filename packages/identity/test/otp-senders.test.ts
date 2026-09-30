import { describe, expect, it, vi } from "vitest";
import {
  OtpSendError, configureOtpSenderFromEnv, fallbackOtpSender, getOtpSender, maskPhone, msg91OtpSender, otpSenderFromEnv, setOtpSender,
  consoleOtpSender, whatsappCloudOtpSender,
} from "../src";

const msg = { to: "+919876543210", code: "123456", channel: "sms" as const, ttlMinutes: 10 };
const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
const env = {
  MSG91_AUTH_KEY: "k", MSG91_OTP_TEMPLATE_ID: "tpl1", MSG91_SENDER_ID: "CNOTEX",
  WHATSAPP_PHONE_NUMBER_ID: "123", WHATSAPP_ACCESS_TOKEN: "tok",
};
const fast = { sleep: async () => {}, log: () => {} };

describe("msg91 sender", () => {
  it("posts the DLT template with authkey header", async () => {
    const f = vi.fn(async () => json(200, { type: "success" }));
    await msg91OtpSender(env, { ...fast, fetch: f as never }).send(msg);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/v5/otp?");
    expect(url).toContain("template_id=tpl1");
    expect(url).toContain("mobile=919876543210");
    expect(url).toContain("sender=CNOTEX");
    expect((init.headers as Record<string, string>).authkey).toBe("k");
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBeTruthy();
  });
  it("does not retry 4xx", async () => {
    const f = vi.fn(async () => json(401));
    await expect(msg91OtpSender(env, { ...fast, fetch: f as never }).send(msg)).rejects.toMatchObject({ permanent: true });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("retries 5xx then succeeds, and gives up after maxAttempts", async () => {
    const f = vi.fn().mockResolvedValueOnce(json(503)).mockResolvedValueOnce(json(200, { type: "success" }));
    await msg91OtpSender(env, { ...fast, fetch: f as never }).send(msg);
    expect(f).toHaveBeenCalledTimes(2);
    const g = vi.fn(async () => json(500));
    await expect(msg91OtpSender(env, { ...fast, fetch: g as never, maxAttempts: 2 }).send({ ...msg, code: "999999" })).rejects.toMatchObject({ permanent: false });
    expect(g).toHaveBeenCalledTimes(2);
  });
  it("treats a 200 error body as permanent and retries network errors", async () => {
    const f = vi.fn(async () => json(200, { type: "error" }));
    await expect(msg91OtpSender(env, { ...fast, fetch: f as never }).send(msg)).rejects.toBeInstanceOf(OtpSendError);
    const g = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(json(200, {}));
    await msg91OtpSender(env, { ...fast, fetch: g as never }).send({ ...msg, code: "111111" });
    expect(g).toHaveBeenCalledTimes(2);
  });
  it("drops an immediate duplicate of the same delivery", async () => {
    const f = vi.fn(async () => json(200, {}));
    const s = msg91OtpSender(env, { ...fast, fetch: f as never });
    await s.send(msg);
    await s.send(msg);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("requires credentials", () => {
    expect(() => msg91OtpSender({})).toThrow(/MSG91_AUTH_KEY/);
  });
});

describe("whatsapp cloud sender", () => {
  it("sends an authentication template with the copy-code button", async () => {
    const f = vi.fn(async () => json(200, { messages: [{ id: "wamid.x" }] }));
    await whatsappCloudOtpSender(env, { ...fast, fetch: f as never }).send({ ...msg, channel: "whatsapp" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/123/messages");
    const body = JSON.parse(init.body as string);
    expect(body.template.components[1]).toMatchObject({ type: "button", sub_type: "url", index: "0" });
    expect(body.to).toBe("919876543210");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });
});

describe("fallback + factory", () => {
  it("falls back to SMS when WhatsApp fails, but not for direct SMS requests", async () => {
    const wa = { send: vi.fn().mockRejectedValue(new Error("nope")) };
    const sms = { send: vi.fn().mockResolvedValue(undefined) };
    const s = fallbackOtpSender(wa, sms, () => {});
    await s.send({ ...msg, channel: "whatsapp" });
    expect(sms.send).toHaveBeenCalledWith(expect.objectContaining({ channel: "sms" }));
    await s.send(msg);
    expect(wa.send).toHaveBeenCalledTimes(1);
    expect(sms.send).toHaveBeenCalledTimes(2);
  });
  it("selects by OTP_SENDER and installs it", () => {
    const prev = getOtpSender();
    expect(otpSenderFromEnv({})).toBe(consoleOtpSender);
    expect(() => otpSenderFromEnv({ OTP_SENDER: "carrier-pigeon" })).toThrow(/Unknown/);
    expect(() => otpSenderFromEnv({ ...env, OTP_SENDER: "msg91" })).not.toThrow();
    expect(() => otpSenderFromEnv({ ...env, OTP_SENDER: "whatsapp_cloud" })).not.toThrow();
    expect(configureOtpSenderFromEnv({ ...env, OTP_SENDER: "whatsapp_then_sms" })).toBe("whatsapp_then_sms");
    expect(getOtpSender()).not.toBe(prev);
    setOtpSender(prev);
  });
  it("masks phones", () => {
    expect(maskPhone("+919876543210")).toBe("*********3210");
    expect(maskPhone("12")).toBe("****");
  });
});

describe("defaults", () => {
  it("uses global fetch, the real sleep and console.warn when no options are given", async () => {
    const f = vi.fn().mockResolvedValueOnce(json(502)).mockResolvedValueOnce(json(200, {}));
    vi.stubGlobal("fetch", f);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await msg91OtpSender(env).send({ ...msg, code: "222222" });
    expect(f).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("222222");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("9876543210");
    // default fallback logger
    const wa = { send: vi.fn().mockRejectedValue(new Error("x")) };
    await fallbackOtpSender(wa, { send: vi.fn().mockResolvedValue(undefined) }).send({ ...msg, channel: "whatsapp" });
    expect(warn.mock.calls.at(-1)![0]).toContain("falling back");
    vi.unstubAllGlobals();
    warn.mockRestore();
  });
});

describe("edge branches", () => {
  it("whatsapp sender drops duplicates and treats 4xx as permanent", async () => {
    const f = vi.fn(async () => json(200, {}));
    const s = whatsappCloudOtpSender(env, { ...fast, fetch: f as never });
    await s.send({ ...msg, channel: "whatsapp" });
    await s.send({ ...msg, channel: "whatsapp" });
    expect(f).toHaveBeenCalledTimes(1);
    const bad = vi.fn(async () => json(400));
    await expect(whatsappCloudOtpSender(env, { ...fast, fetch: bad as never }).send({ ...msg, code: "555555", channel: "whatsapp" })).rejects.toMatchObject({ permanent: true });
  });
  it("msg91 without sender id or ok json body, and configure defaults to console", async () => {
    const f = vi.fn(async () => new Response("not json", { status: 200 }));
    const { MSG91_SENDER_ID: _drop, ...noSender } = env;
    await msg91OtpSender(noSender, { ...fast, fetch: f as never }).send({ ...msg, code: "666666" });
    expect((f.mock.calls[0] as unknown as [string])[0]).not.toContain("sender=");
    const prev = getOtpSender();
    expect(configureOtpSenderFromEnv({})).toBe("console");
    setOtpSender(prev);
  });
  it("429 is retried", async () => {
    const f = vi.fn().mockResolvedValueOnce(json(429)).mockResolvedValueOnce(json(200, {}));
    await msg91OtpSender(env, { ...fast, fetch: f as never }).send({ ...msg, code: "777777" });
    expect(f).toHaveBeenCalledTimes(2);
  });
});
