import { MemoryJobQueue, setJobQueue, type QueueMessage } from "@cnote/core";
import { prisma } from "@cnote/db";
import { setConsent } from "@cnote/identity";
import { defineTemplates, listTemplateDefinitions, previewEmail, seedDefaultTemplates } from "@cnote/templates";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PermanentEmailError, createEmailProvider, createQueuedMailer, getEmailProvider, handleEmailSend, maskEmail, sendEmail, sendTestEmail, setEmailProvider, type EmailJob, type EmailProvider,
  type OutgoingEmail,
} from "../src/index";
import { ConsoleEmailProvider, fromAddress } from "../src/providers";

// Lets a test force renderEmail to fail with a non-domain error (e.g. the database going away mid-render).
let renderOverride: (() => Promise<never>) | null = null;
vi.mock("@cnote/templates", async (importOriginal) => {
  const m = await importOriginal<typeof import("@cnote/templates")>();
  return { ...m, renderEmail: (...a: Parameters<typeof m.renderEmail>) => (renderOverride ? renderOverride() : m.renderEmail(...a)) };
});

const tag = randomUUID().slice(0, 8);
const MKT = `test.more_promo_${tag}`;
const SEC = `test.more_sec_${tag}`;
defineTemplates([
  { key: MKT, name: "Promo", description: "d", category: "marketing", channels: ["email"], variables: [], defaults: { email: { subject: "Deal", body: "<p>Big deal</p>" } } },
  { key: SEC, name: "Sec", description: "d", category: "security", channels: ["email"], variables: [], defaults: { email: { subject: "Alert", body: "<p>Alert</p>" } } },
]);

const sent: OutgoingEmail[] = [];
let behaviour: "ok" | "transient" | "permanent" | "slow" = "ok";
const provider: EmailProvider = {
  name: "test",
  async send(m) {
    if (behaviour === "transient") throw new Error("smtp timeout");
    if (behaviour === "permanent") throw new PermanentEmailError("mailbox does not exist");
    sent.push(m);
    return { messageId: `t-${sent.length}` };
  },
};
const persons: string[] = [];
const dedupeKeys: string[] = [];
const person = async (over: { erasedAt?: Date | null } = {}) => {
  const p = await prisma.person.create({ data: { email: `email-more-${randomUUID()}@example.com`, ...over } });
  persons.push(p.id);
  return p;
};
const dk = () => {
  const k = `dk-${randomUUID()}`;
  dedupeKeys.push(k);
  return k;
};
const msg = (job: EmailJob, over: Partial<QueueMessage<EmailJob>> = {}): QueueMessage<EmailJob> => ({ id: "m", topic: "email.send", attempt: 1, maxAttempts: 5, enqueuedAt: "", payload: job, ...over });
const rowOf = (id: string) => prisma.emailMessage.findUniqueOrThrow({ where: { id } });

let queue: MemoryJobQueue;
let now = 1_000_000;
beforeAll(async () => {
  await seedDefaultTemplates();
});
beforeEach(() => {
  now = 1_000_000;
  queue = new MemoryJobQueue(() => now);
  setJobQueue(queue);
  setEmailProvider(provider);
  sent.length = 0;
  behaviour = "ok";
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  setJobQueue(undefined);
  setEmailProvider(undefined);
  await prisma.emailMessage.deleteMany({ where: { OR: [{ toPersonId: { in: persons } }, { dedupeKey: { in: dedupeKeys } }, { template: { in: [MKT, SEC] } }, { toMasked: { startsWith: "z***@more-" } }] } });
  await prisma.consent.deleteMany({ where: { personId: { in: persons } } });
  await prisma.person.deleteMany({ where: { id: { in: persons } } });
});

describe("maskEmail", () => {
  it.each([["asha@gmail.com", "a***@gmail.com"], ["a@b.co", "a***@b.co"], ["ab+tag@x.io", "a***@x.io"], ["Ünï@x.de", "Ü***@x.de"], ["😀@x.com", "😀***@x.com"], ["x@y@z.com", "x***@z.com"]])("%s -> %s", (i, o) => expect(maskEmail(i)).toBe(o));
  it.each(["", "nodomain", "@x.com", "  "])("%j -> ***", (i) => expect(maskEmail(i)).toBe("***"));
  it("PROPERTY: hides everything but the first character and the domain; output is well-formed UTF-16", () => {
    const local = fc.string({ unit: "grapheme", minLength: 2, maxLength: 20 }).filter((s) => !s.includes("@"));
    fc.assert(
      fc.property(local, fc.domain(), (l, d) => {
        const out = maskEmail(`${l}@${d}`);
        const first = Array.from(l)[0]!;
        expect(out).toBe(`${first}***@${d}`);
        expect(out.isWellFormed()).toBe(true);
        expect(out.length).toBeLessThan(`${l}@${d}`.length + 4);
        for (const ch of Array.from(l).slice(1)) if (ch.length && !"***@".includes(ch) && !d.includes(ch)) expect(out.includes(l.slice(first.length))).toBe(l.slice(first.length).length === 0);
      }),
      { seed: 5, numRuns: 300 },
    );
  });
});

describe("sendEmail: validation & suppression", () => {
  it.each(["", " ", "plain", "a@b", "a@@b.co", "@b.co", "a@.co", "a b@c.co", "a@b .co", "a@b.co\nBcc: x@y.z", "a,b@c.co x@y.z", `${"a".repeat(250)}@b.co`])("rejects address %j", async (email) => {
    await expect(sendEmail({ template: "system.test", to: { email }, vars: {} })).rejects.toMatchObject({ code: "validation" });
    expect(queue.deadLetters).toBeDefined();
  });
  it("trims whitespace around a valid address and accepts the 254-char limit", async () => {
    const k = dk();
    const id = await sendEmail({ template: "system.test", to: { email: `  z@more-${tag}.example.com \n` }, vars: { message: "x" }, dedupeKey: k });
    expect(id).toBeTruthy();
    await queue.consume("email.send", "email", "t", handleEmailSend);
    expect(sent[0]!.to).toBe(`z@more-${tag}.example.com`);
    const long = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(58)}.co`;
    expect(long.length).toBe(254);
    const k2 = dk();
    expect(await sendEmail({ template: "system.test", to: { email: long }, vars: { message: "x" }, dedupeKey: k2 })).toBeTruthy();
    await expect(sendEmail({ template: "system.test", to: { email: `a${long}` }, vars: {} })).rejects.toMatchObject({ code: "validation" });
  });
  it("security mail needs no consent; marketing needs consent (revocation is honoured at enqueue time)", async () => {
    const p = await person();
    expect(await sendEmail({ template: SEC, to: { email: "s@example.com", personId: p.id }, vars: {}, dedupeKey: dk() })).toBeTruthy();
    expect(await sendEmail({ template: MKT, to: { email: "s@example.com", personId: p.id }, vars: {} })).toBeNull();
    await setConsent(p.id, "marketing", true, "test");
    expect(await sendEmail({ template: MKT, to: { email: "s@example.com", personId: p.id }, vars: {}, dedupeKey: dk() })).toBeTruthy();
    await setConsent(p.id, "marketing", false, "test");
    expect(await sendEmail({ template: MKT, to: { email: "s@example.com", personId: p.id }, vars: {} })).toBeNull();
  });
  it("an unknown person id is treated as erased (suppressed, never sent)", async () => {
    expect(await sendEmail({ template: "system.test", to: { email: "u@example.com", personId: randomUUID() }, vars: {} })).toBeNull();
  });
  it("suppressed sends are recorded once per dedupeKey and never enqueued", async () => {
    const p = await person({ erasedAt: new Date() });
    const k = dk();
    await sendEmail({ template: "system.test", to: { email: "e@example.com", personId: p.id }, vars: {}, dedupeKey: k });
    await sendEmail({ template: "system.test", to: { email: "e@example.com", personId: p.id }, vars: {}, dedupeKey: k });
    expect(await prisma.emailMessage.count({ where: { dedupeKey: k } })).toBe(1);
    expect(await queue.consume("email.send", "email", "t", handleEmailSend)).toBe(0);
    expect(sent).toHaveLength(0);
    expect(await prisma.emailMessage.findFirstOrThrow({ where: { dedupeKey: k } })).toMatchObject({ status: "suppressed", lastError: "recipient erased" });
  });
  it("no plaintext address or variables are ever stored in the database row", async () => {
    const k = dk();
    const id = (await sendEmail({ template: "system.test", to: { email: `secret.person@more-${tag}.example.com`, name: "Secret Person" }, vars: { message: "confidential-body" }, dedupeKey: k }))!;
    await queue.consume("email.send", "email", "t", handleEmailSend);
    const json = JSON.stringify(await rowOf(id));
    expect(json).not.toContain("secret.person");
    expect(json).not.toContain("confidential-body");
    expect(json).not.toContain("Secret Person");
  });
});

describe("sendEmail: idempotency & failure paths", () => {
  it("N parallel calls with one dedupeKey create exactly one message and one queued job", async () => {
    const k = dk();
    const ids = await Promise.all(Array.from({ length: 8 }, () => sendEmail({ template: "system.test", to: { email: "p@example.com" }, vars: { message: "x" }, dedupeKey: k })));
    expect(ids.filter(Boolean)).toHaveLength(1);
    expect(await prisma.emailMessage.count({ where: { dedupeKey: k } })).toBe(1);
    expect(await queue.consume("email.send", "email", "t", handleEmailSend)).toBe(1);
    expect(sent).toHaveLength(1);
  });
  it("without a dedupeKey every call is a distinct message", async () => {
    const a = await sendEmail({ template: "system.test", to: { email: "n@example.com" }, vars: { message: "x" } });
    const b = await sendEmail({ template: "system.test", to: { email: "n@example.com" }, vars: { message: "x" } });
    expect(a).not.toBe(b);
    await prisma.emailMessage.deleteMany({ where: { id: { in: [a!, b!] } } });
  });
  it("non-serialisable variables (bigint / circular) are a validation error and the row is marked failed", async () => {
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    for (const vars of [{ n: 10n }, circ]) {
      const k = dk();
      await expect(sendEmail({ template: "system.test", to: { email: "j@example.com" }, vars, dedupeKey: k })).rejects.toMatchObject({ code: "validation" });
      expect(await prisma.emailMessage.findFirstOrThrow({ where: { dedupeKey: k } })).toMatchObject({ status: "failed", lastError: "variables are not serialisable" });
    }
    expect(await queue.consume("email.send", "email", "t", handleEmailSend)).toBe(0);
  });
  it("variables are deep-copied to JSON (undefined dropped, Date -> ISO) before queueing", async () => {
    const k = dk();
    await sendEmail({ template: "system.message", to: { email: "d@example.com" }, vars: { subject: "s", message: "m", when: new Date("2026-01-02T03:04:05Z"), skip: undefined }, dedupeKey: k });
    let payload: EmailJob | undefined;
    await queue.consume("email.send", "email", "t", async (m) => void (payload = m.payload));
    expect(payload!.vars).toEqual({ subject: "s", message: "m", when: "2026-01-02T03:04:05.000Z" });
  });
  it("delayMs postpones the job until due", async () => {
    await sendEmail({ template: "system.test", to: { email: "later@example.com" }, vars: { message: "x" }, delayMs: 60_000, dedupeKey: dk() });
    expect(await queue.consume("email.send", "email", "t", handleEmailSend)).toBe(0);
    now += 59_999;
    expect(await queue.promoteDelayed("email.send")).toBe(0);
    now += 1;
    expect(await queue.promoteDelayed("email.send")).toBe(1);
    await queue.consume("email.send", "email", "t", handleEmailSend);
    expect(sent).toHaveLength(1);
  });
  it("REGRESSION: a failed enqueue marks the row failed and frees the dedupeKey so the caller's retry goes through", async () => {
    const k = dk();
    const failing = vi.spyOn(queue, "enqueue").mockRejectedValueOnce(new Error("redis down"));
    await expect(sendEmail({ template: "system.test", to: { email: "r@example.com" }, vars: { message: "x" }, dedupeKey: k })).rejects.toThrow("redis down");
    failing.mockRestore();
    const failedRow = await prisma.emailMessage.findFirstOrThrow({ where: { template: "system.test", lastError: { startsWith: "enqueue failed" }, toMasked: "r***@example.com" }, orderBy: { createdAt: "desc" } });
    expect(failedRow).toMatchObject({ status: "failed", dedupeKey: null });
    const retry = await sendEmail({ template: "system.test", to: { email: "r@example.com" }, vars: { message: "x" }, dedupeKey: k });
    expect(retry).toBeTruthy();
    await queue.consume("email.send", "email", "t", handleEmailSend);
    expect(sent).toHaveLength(1);
    await prisma.emailMessage.delete({ where: { id: failedRow.id } });
  });
});

describe("handleEmailSend", () => {
  const job = (id: string, over: Partial<EmailJob> = {}): EmailJob => ({ messageId: id, to: "h@example.com", template: "system.test", vars: { message: "x" }, ...over });
  const queued = async (over: Parameters<typeof sendEmail>[0] extends infer T ? Partial<T> : never = {}) =>
    (await sendEmail({ template: "system.test", to: { email: "h@example.com" }, vars: { message: "x" }, dedupeKey: dk(), ...over }))!;

  it("a message that no longer exists is ignored", async () => {
    await expect(handleEmailSend(msg(job(randomUUID())))).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
  });
  it("already sent / suppressed messages are never sent again (duplicate delivery)", async () => {
    const id = await queued();
    await handleEmailSend(msg(job(id)));
    await handleEmailSend(msg(job(id), { attempt: 2 }));
    await handleEmailSend(msg(job(id), { attempt: 3 }));
    expect(sent).toHaveLength(1);
    expect((await rowOf(id)).attempts).toBe(1);
    await prisma.emailMessage.update({ where: { id }, data: { status: "suppressed" } });
    await handleEmailSend(msg(job(id)));
    expect(sent).toHaveLength(1);
  });
  it("counts attempts across retries, goes back to queued between attempts, failed on the last, and truncates error text to 500 chars", async () => {
    const id = await queued();
    behaviour = "transient";
    const long = new Error("x".repeat(2000));
    vi.spyOn(provider, "send").mockRejectedValue(long);
    for (const attempt of [1, 2, 3, 4]) {
      await expect(handleEmailSend(msg(job(id), { attempt }))).rejects.toBe(long);
      expect(await rowOf(id)).toMatchObject({ status: "queued", attempts: attempt });
    }
    await expect(handleEmailSend(msg(job(id), { attempt: 5 }))).rejects.toBe(long);
    const row = await rowOf(id);
    expect(row).toMatchObject({ status: "failed", attempts: 5 });
    expect(row.lastError).toHaveLength(500);
    vi.restoreAllMocks();
    behaviour = "ok";
    await handleEmailSend(msg(job(id), { attempt: 1 })); // e.g. dead-letter replay
    expect(await rowOf(id)).toMatchObject({ status: "sent", lastError: null });
  });
  it("permanent failures are recorded without retry and never touch the queue", async () => {
    const id = await queued();
    behaviour = "permanent";
    await expect(handleEmailSend(msg(job(id)))).resolves.toBeUndefined();
    expect(await rowOf(id)).toMatchObject({ status: "failed", lastError: "mailbox does not exist" });
    expect(sent).toHaveLength(0);
  });
  it("unknown template at send time is a permanent (non-retryable) failure", async () => {
    const id = await queued();
    await expect(handleEmailSend(msg(job(id, { template: "zz.never_registered" })))).resolves.toBeUndefined();
    expect((await rowOf(id)).status).toBe("failed");
    expect((await rowOf(id)).lastError).toContain("render:");
  });
  it("a non-domain render error (infrastructure) is retried via the queue, recorded, and the last attempt marks failed", async () => {
    const id = await queued();
    renderOverride = async () => Promise.reject(new Error("connection lost"));
    try {
      await expect(handleEmailSend(msg(job(id), { attempt: 1 }))).rejects.toThrow("connection lost");
      expect(await rowOf(id)).toMatchObject({ status: "queued", lastError: "connection lost", attempts: 1 });
      await expect(handleEmailSend(msg(job(id), { attempt: 5 }))).rejects.toThrow("connection lost");
      expect((await rowOf(id)).status).toBe("failed");
    } finally {
      renderOverride = null;
    }
    expect(sent).toHaveLength(0);
  });
  it("database errors while recording a message propagate (the caller sees the failure, nothing is enqueued)", async () => {
    const p = await person({ erasedAt: new Date() });
    vi.spyOn(prisma.emailMessage, "create").mockRejectedValueOnce(new Error("db down"));
    await expect(sendEmail({ template: "system.test", to: { email: "x@example.com", personId: p.id }, vars: {} })).rejects.toThrow("db down"); // suppression path
    vi.spyOn(prisma.emailMessage, "create").mockRejectedValueOnce(new Error("db down 2"));
    await expect(sendEmail({ template: "system.test", to: { email: "x@example.com" }, vars: {} })).rejects.toThrow("db down 2"); // normal path
    expect(await queue.consume("email.send", "email", "t", handleEmailSend)).toBe(0);
  });
  it("passes a rendered subject/html/text, the configured From, and the locale through to the provider", async () => {
    const id = await queued({ template: "system.message", vars: { subject: "Order {{n}} <ok>", message: "M" } });
    const spy = vi.spyOn(provider, "send");
    await handleEmailSend(msg(job(id, { template: "system.message", vars: { subject: "Custom subject", message: "Body text" }, locale: "hi", toName: "Asha" })));
    const arg = spy.mock.calls[0]![0];
    expect(arg).toMatchObject({ id, to: "h@example.com", toName: "Asha", from: fromAddress(), subject: "Custom subject" });
    expect(arg.html).toContain("Body text");
    expect(arg.text).toContain("Body text");
    expect(await rowOf(id)).toMatchObject({ subject: "Custom subject", status: "sent", provider: "test" });
  });
  it("REGRESSION: erasure requested while the job waited is honoured at send time", async () => {
    const p = await person();
    const id = (await sendEmail({ template: "system.test", to: { email: "w@example.com", personId: p.id }, vars: { message: "x" }, dedupeKey: dk() }))!;
    await prisma.person.update({ where: { id: p.id }, data: { erasedAt: new Date() } });
    await queue.consume("email.send", "email", "t", handleEmailSend);
    expect(sent).toHaveLength(0);
    expect(await rowOf(id)).toMatchObject({ status: "suppressed", lastError: "recipient erased" });
  });
  it("REGRESSION: marketing consent withdrawn while the job waited is honoured at send time; still sent if consent remains", async () => {
    const p = await person();
    await setConsent(p.id, "marketing", true, "test");
    const id = (await sendEmail({ template: MKT, to: { email: "w2@example.com", personId: p.id }, vars: {}, dedupeKey: dk(), delayMs: 1000 }))!;
    await setConsent(p.id, "marketing", false, "test");
    now += 2000;
    await queue.promoteDelayed("email.send");
    await queue.consume("email.send", "email", "t", handleEmailSend);
    expect(sent).toHaveLength(0);
    expect(await rowOf(id)).toMatchObject({ status: "suppressed", lastError: "no marketing consent" });

    await setConsent(p.id, "marketing", true, "test");
    const id2 = (await sendEmail({ template: MKT, to: { email: "w2@example.com", personId: p.id }, vars: {}, dedupeKey: dk() }))!;
    await queue.consume("email.send", "email", "t", handleEmailSend);
    expect(sent).toHaveLength(1);
    expect((await rowOf(id2)).status).toBe("sent");
  });
  it("non-marketing mail is not blocked by missing marketing consent", async () => {
    const p = await person();
    const id = (await sendEmail({ template: SEC, to: { email: "sec@example.com", personId: p.id }, vars: {}, dedupeKey: dk() }))!;
    await queue.consume("email.send", "email", "t", handleEmailSend);
    expect((await rowOf(id)).status).toBe("sent");
  });
  it("List-Unsubscribe: marketing only; custom link only when it is a clean http(s) URL (no header injection)", async () => {
    const p = await person();
    await setConsent(p.id, "marketing", true, "test");
    const send = async (unsubscribeUrl?: unknown) => {
      sent.length = 0;
      const id = (await sendEmail({ template: MKT, to: { email: "u@example.com", personId: p.id }, vars: {}, dedupeKey: dk() }))!;
      await queue.consume("email.send", "email", "t", async (m) => handleEmailSend({ ...m, payload: { ...m.payload, vars: unsubscribeUrl === undefined ? {} : { unsubscribeUrl } } }));
      void id;
      return sent[0]!.headers?.["List-Unsubscribe"];
    };
    process.env.APP_URL = "https://app.example.in/";
    expect(await send()).toBe("<https://app.example.in/account/notifications>");
    expect(await send("https://x.example/u?t=1")).toBe("<https://x.example/u?t=1>");
    for (const evil of ["https://x.example/u>\r\nBcc: evil@x.com", "javascript:alert(1)", "https://x.example/ u", "https://x.example/<b>", 42, null, "ftp://x/u"]) expect(await send(evil), String(evil)).toBe("<https://app.example.in/account/notifications>");
    delete process.env.APP_URL;
    // transactional mail never carries the header
    sent.length = 0;
    await sendEmail({ template: "system.test", to: { email: "t@example.com" }, vars: { message: "x" }, dedupeKey: dk() });
    await queue.consume("email.send", "email", "t", handleEmailSend);
    expect(sent[0]!.headers).toEqual({});
  });
});

describe("sendTestEmail", () => {
  it("validates template and address, prefixes the subject, honours version overrides, and does not write an EmailMessage", async () => {
    await expect(sendTestEmail("zz.nope", "a@b.co", {})).rejects.toMatchObject({ code: "validation" });
    await expect(sendTestEmail("system.test", "not-an-email", {})).rejects.toMatchObject({ code: "validation" });
    await expect(sendTestEmail("system.test", "a@b.co\r\nBcc: x@y.z", {})).rejects.toMatchObject({ code: "validation" });
    const before = await prisma.emailMessage.count();
    const res = await sendTestEmail("system.test", "  staff@example.com ", { message: "explicit" });
    expect(res).toMatchObject({ provider: "test", messageId: expect.stringMatching(/^t-/) });
    expect(sent[0]).toMatchObject({ to: "staff@example.com" });
    expect(sent[0]!.subject).toBe("[Test] Test email");
    expect(sent[0]!.html).toContain("explicit");
    expect(await prisma.emailMessage.count()).toBe(before);
    await expect(sendTestEmail("system.test", "a@b.co", {}, { versionId: randomUUID() })).rejects.toMatchObject({ code: "not_found" });
    await expect(sendTestEmail("system.test", "a@b.co", {}, { layoutVersionId: randomUUID() })).rejects.toMatchObject({ code: "not_found" });
  });
  it("fills missing variables from the definition's examples but lets explicit values win", async () => {
    await sendTestEmail("auth.new_sign_in", "s@example.com", { device: "Firefox on Linux" });
    expect(sent[0]!.html).toContain("Firefox on Linux");
    expect(sent[0]!.html).toContain("203.0.113.7");
  });
});

describe("createQueuedMailer", () => {
  const run = async (m: { to: string; subject: string; text: string }) => {
    await createQueuedMailer().send(m);
    await queue.consume("email.send", "email", "t", handleEmailSend);
    await prisma.emailMessage.deleteMany({ where: { toMasked: maskEmail(m.to), template: { in: ["auth.password_reset", "system.message"] }, toPersonId: null } });
  };
  it.each([
    ["https://app.example.com/reset?token=abc.", "https://app.example.com/reset?token=abc"],
    ["https://app.example.com/reset?token=abc)", "https://app.example.com/reset?token=abc"],
    ["https://app.example.com/reset?token=a.b-c_d", "https://app.example.com/reset?token=a.b-c_d"],
  ])("REGRESSION: reset link %s has trailing punctuation removed", async (text, url) => {
    sent.length = 0;
    await run({ to: "mailer@example.com", subject: "Reset your password", text: `Use this link: ${text}` });
    expect(sent[0]!.html).toContain(`href="${url}"`);
  });
  it("non-reset subjects and reset subjects without a link go out as system.message with the original text", async () => {
    sent.length = 0;
    await run({ to: "mailer@example.com", subject: "Welcome!", text: "Visit https://x.example/a" });
    expect(sent[0]!.subject).toBe("Welcome!");
    expect(sent[0]!.html).toContain("Visit https://x.example/a");
    await run({ to: "mailer@example.com", subject: "Password RESET help", text: "No link here" });
    expect(sent[1]!.subject).toBe("Password RESET help");
  });
});

describe("providers", () => {
  it("createEmailProvider builds each driver; unknown names throw; stubs fail loudly and never silently succeed", async () => {
    expect(createEmailProvider("console").name).toBe("console");
    for (const n of ["smtp", "ses", "resend"] as const) {
      const p = createEmailProvider(n);
      expect(p.name).toBe(n);
      await expect(p.send({ id: "1", to: "a@b.co", from: "f", subject: "s", html: "", text: "" })).rejects.toThrow(`EMAIL_PROVIDER=${n} is not configured`);
    }
    expect(() => createEmailProvider("sendgrid" as never)).toThrow('Unknown EMAIL_PROVIDER "sendgrid"');
  });
  it("getEmailProvider memoises, follows EMAIL_PROVIDER, and setEmailProvider(undefined) resets", () => {
    const prev = process.env.EMAIL_PROVIDER;
    setEmailProvider(undefined);
    process.env.EMAIL_PROVIDER = "ses";
    const a = getEmailProvider();
    expect(a.name).toBe("ses");
    expect(getEmailProvider()).toBe(a);
    delete process.env.EMAIL_PROVIDER;
    expect(getEmailProvider()).toBe(a); // still memoised
    setEmailProvider(undefined);
    expect(getEmailProvider().name).toBe("console");
    if (prev === undefined) delete process.env.EMAIL_PROVIDER;
    else process.env.EMAIL_PROVIDER = prev;
    setEmailProvider(provider);
  });
  it("fromAddress defaults and env override", () => {
    const prev = process.env.EMAIL_FROM;
    delete process.env.EMAIL_FROM;
    expect(fromAddress()).toMatch(/no-reply@/);
    process.env.EMAIL_FROM = "X <x@y.z>";
    expect(fromAddress()).toBe("X <x@y.z>");
    if (prev === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = prev;
  });
  it("ConsoleEmailProvider writes the html preview under <repo>/.data/mail (repo root found by pnpm-workspace.yaml) and logs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mail-root-"));
    try {
      await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
      vi.spyOn(process, "cwd").mockReturnValue(path.join(root, "nested"));
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const id = randomUUID();
      const res = await new ConsoleEmailProvider().send({ id, to: "c@example.com", from: "f", subject: "Hello", html: "<p>preview</p>", text: "t" });
      expect(res.messageId).toMatch(/^console-[0-9a-f-]{36}$/);
      expect(await readFile(path.join(root, ".data", "mail", `${id}.html`), "utf8")).toBe("<p>preview</p>");
      expect(info.mock.calls[0]![0]).toContain('subject="Hello"');
      expect(await new ConsoleEmailProvider().send({ id, to: "c@example.com", from: "f", subject: "s", html: "<p>2</p>", text: "t" }).then((r) => r.messageId)).not.toBe(res.messageId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("registered email templates (invariants over every definition)", () => {
  const defs = () => listTemplateDefinitions().filter((d) => d.channels.includes("email") && d.defaults.email);
  it("email owns its auth/system templates", () => {
    const keys = defs().map((d) => d.key);
    for (const k of ["auth.password_reset", "auth.welcome", "auth.new_sign_in", "system.test", "system.message"]) expect(keys).toContain(k);
  });
  it("every definition renders from its own defaults + example variables: non-empty subject, no unresolved tags, no dangerous markup, required vars all have examples", async () => {
    for (const d of defs()) {
      const e = d.defaults.email!;
      for (const v of d.variables.filter((x) => x.required)) expect(v.example, `${d.key}.${v.name} needs an example`).toBeTruthy();
      const r = await previewEmail({ key: d.key, subject: e.subject ?? null, preheader: e.preheader ?? null, body: e.body });
      expect(r.subject.trim(), d.key).not.toBe("");
      expect(`${r.subject}${r.preheader ?? ""}${r.html}${r.text}`, d.key).not.toMatch(/\{\{|\}\}/);
      expect(r.html, d.key).not.toMatch(/<script|<[a-z][^>]*\son[a-z]+\s*=|javascript:/i);
      expect(r.text.length, d.key).toBeGreaterThan(5);
    }
  });
  it("the password-reset email always carries the reset link and never renders it as text-only", async () => {
    const d = defs().find((x) => x.key === "auth.password_reset")!;
    const r = await previewEmail({ key: d.key, subject: d.defaults.email!.subject!, preheader: null, body: d.defaults.email!.body, vars: { resetUrl: "https://app.example.com/reset?token=t&x=1" } });
    expect(r.html).toContain('href="https://app.example.com/reset?token=t&amp;x=1"');
    expect(r.text).toContain("https://app.example.com/reset?token=t&x=1");
  });
  it("a hostile reset URL variable cannot become a javascript: link", async () => {
    const d = defs().find((x) => x.key === "auth.password_reset")!;
    const r = await previewEmail({ key: d.key, subject: "s", preheader: null, body: d.defaults.email!.body, vars: { resetUrl: "javascript:alert(document.cookie)" } });
    expect(r.html).not.toMatch(/href="javascript/i);
  });
});
