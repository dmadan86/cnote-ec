import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MockKycProvider, beginVideoKyc, completeKyc, decideKyc, getKycReview, getKycSession, handleKycWebhook, kycPorts, listKycReviews, purgeKycDocuments,
  readKycDocumentImage, setKycPorts, setKycProvider, signKycWebhook, startKyc, uploadKycDocument, KYC_RETENTION_DAYS,
  type KycExtraction, type KycPorts,
} from "../src";

const tag = randomUUID().slice(0, 6);
const bizIds: string[] = [];
const personIds: string[] = [];
const day = 86_400_000;

const rnd = () => String(Math.floor(Math.random() * 9000) + 1000);
async function seed(o: { tier?: number; name?: string } = {}) {
  const pan = `KX${tag.slice(0, 3).toUpperCase().replace(/[^A-Z]/g, "Q")}${"ABCDEFGH"[Math.floor(Math.random() * 8)]}${rnd()}F`.slice(0, 10);
  const gstin = `27${pan}1Z${"ABCDEFGH"[Math.floor(Math.random() * 8)]}`;
  const person = await prisma.person.create({ data: { email: `kyc-${tag}-${randomUUID().slice(0, 5)}@example.test`, name: "Ramesh Sharma" } });
  const biz = await prisma.business.create({ data: { name: o.name ?? "Sharma Steel", legalName: o.name ?? "Sharma Steel Private Limited", gstin, verificationTier: o.tier ?? 1, gstLastCheckedAt: new Date(), isSeller: false } });
  await prisma.businessMember.create({ data: { businessId: biz.id, personId: person.id, role: "owner" } });
  bizIds.push(biz.id); personIds.push(person.id);
  return { actor: { personId: person.id, businessId: biz.id }, gstin, pan, biz, person };
}

let stored: Map<string, Uint8Array>;
let extraction: (docType: string, gstin: string, pan: string) => KycExtraction;
let dims = { width: 1600, height: 1000 };
const png = (s: string) => Buffer.from(`${s}-${randomUUID()}`);

function makePorts(ctx: { gstin: string; pan: string }): KycPorts {
  return {
    store: {
      put: async (k, b) => void stored.set(k, b),
      get: async (k) => (stored.has(k) ? { bytes: stored.get(k)!, contentType: "image/jpeg" } : null),
      delete: async (k) => void stored.delete(k),
    },
    inspectImage: (b) => {
      if (b.length < 4) throw new Error("The file is empty");
      return { mime: "image/jpeg", ext: "jpg", ...dims, sha256: createHash("sha256").update(b).digest("hex") };
    },
    extractDocument: async (i) => extraction(i.docType, ctx.gstin, ctx.pan),
  };
}
const good = (docType: string, gstin: string, pan: string): KycExtraction => ({
  fields: docType === "gst_certificate" ? { gstin, name: "Sharma Steel Private Limited", pan } : { pan, name: "Sharma Steel Private Limited" },
  forgerySignals: [], confidence: 0.95, needsReview: false, decisionId: "d1",
});

let mock: MockKycProvider;
beforeEach(() => { stored = new Map(); extraction = good; dims = { width: 1600, height: 1000 }; mock = new MockKycProvider(); setKycProvider(mock); });
afterEach(() => { setKycProvider(null); setKycPorts(null); });
afterAll(async () => {
  const sessions = (await prisma.kycSession.findMany({ where: { businessId: { in: bizIds } }, select: { id: true } })).map((s) => s.id);
  await prisma.domainEvent.deleteMany({ where: { OR: [{ aggregateId: { in: sessions } }, { aggregateId: { in: bizIds } }] } });
  await prisma.kycSession.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.verificationRecord.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.businessMember.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
});

async function upload(s: Awaited<ReturnType<typeof seed>>, sessionId: string, docType: "gst_certificate" | "pan_card" | "bank_proof" = "gst_certificate") {
  return uploadKycDocument(s.actor, sessionId, { docType, bytes: png(docType), mimeType: "image/jpeg" });
}
async function ready(s: Awaited<ReturnType<typeof seed>>) {
  setKycPorts(makePorts(s));
  const sess = await startKyc(s.actor);
  await upload(s, sess.id, "gst_certificate");
  await upload(s, sess.id, "pan_card");
  return sess.id;
}
const events = (id: string) => prisma.domainEvent.findMany({ where: { aggregateId: id }, orderBy: { id: "asc" } }).then((r) => r.map((e) => e.type));

describe("startKyc", () => {
  it("requires the owner, T1 and returns the single active session", async () => {
    const s = await seed();
    const a = await startKyc(s.actor);
    expect(a.status).toBe("initiated");
    expect(a.missingRequired).toEqual(["gst_certificate", "pan_card"]);
    expect((await startKyc(s.actor)).id).toBe(a.id);
    expect((await getKycSession(s.actor))!.id).toBe(a.id);

    const other = await prisma.person.create({ data: { email: `kyc-o-${tag}-${randomUUID().slice(0, 4)}@example.test` } });
    personIds.push(other.id);
    await expect(startKyc({ personId: other.id, businessId: s.actor.businessId })).rejects.toThrow(/owner/);
    const t0 = await seed({ tier: 0 });
    await expect(startKyc(t0.actor)).rejects.toThrow(/GSTIN first/);
    const t2 = await seed({ tier: 2 });
    await expect(startKyc(t2.actor)).rejects.toThrow(/already/);
    await expect(startKyc({ personId: s.actor.personId, businessId: randomUUID() })).rejects.toThrow();
    const nobody = await seed();
    await prisma.business.delete({ where: { id: nobody.actor.businessId } }).catch(() => {});
  });

  it("expires a stale session and opens a new one; getKycSession is null with none", async () => {
    const s = await seed();
    expect(await getKycSession(s.actor)).toBeNull();
    const a = await startKyc(s.actor);
    await prisma.kycSession.update({ where: { id: a.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const b = await startKyc(s.actor);
    expect(b.id).not.toBe(a.id);
    expect((await prisma.kycSession.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("expired");
    await prisma.kycSession.update({ where: { id: b.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await getKycSession(s.actor))!.status).toBe("expired");
  });
});

describe("uploadKycDocument", () => {
  it("stores privately, masks + encrypts PAN, replaces the earlier upload of a type", async () => {
    const s = await seed();
    setKycPorts(makePorts(s));
    const sess = await startKyc(s.actor);
    const r = await upload(s, sess.id, "pan_card");
    expect(r.document.verdict).toBe("pass");
    expect(r.document.extracted.pan).toBe(`XXXXX${s.pan.slice(5)}`);
    expect(r.document.extracted).not.toHaveProperty("panEnc");
    const row = await prisma.kycDocument.findUniqueOrThrow({ where: { id: r.document.id } });
    expect((row.extracted as { panEnc: string }).panEnc).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain(s.pan);
    expect(row.storageKey).toMatch(/^kyc\//); // private-only prefix in @cnote/media
    expect(stored.has(row.storageKey!)).toBe(true);
    expect((await readKycDocumentImage(row.id))!.bytes.length).toBeGreaterThan(0);

    const r2 = await upload(s, sess.id, "pan_card");
    expect(stored.has(row.storageKey!)).toBe(false); // superseded image dropped
    expect(await prisma.kycDocument.count({ where: { sessionId: sess.id, docType: "pan_card" } })).toBe(1);
    expect(r2.document.id).not.toBe(r.document.id);
    expect(await readKycDocumentImage(randomUUID())).toBeNull();
  });

  it("fails a document whose file was submitted by another business, and on GSTIN mismatch", async () => {
    const a = await seed(), b = await seed();
    setKycPorts(makePorts(a));
    const sa = await startKyc(a.actor);
    const bytes = png("shared");
    await uploadKycDocument(a.actor, sa.id, { docType: "gst_certificate", bytes, mimeType: "image/jpeg" });
    setKycPorts(makePorts(b));
    const sb = await startKyc(b.actor);
    const dup = await uploadKycDocument(b.actor, sb.id, { docType: "gst_certificate", bytes, mimeType: "image/jpeg" });
    expect(dup.document.verdict).toBe("fail");
    expect(dup.document.reasons.join()).toMatch(/another business/);
    extraction = (t) => ({ ...good(t, "27ZZZZZ9999Z1Z5", b.pan) });
    const mis = await upload(b, sb.id, "gst_certificate");
    expect(mis.document.verdict).toBe("fail");
    // same business re-uploading identical bytes is not a duplicate
    extraction = good;
    setKycPorts(makePorts(a));
    expect((await uploadKycDocument(a.actor, sa.id, { docType: "gst_certificate", bytes, mimeType: "image/jpeg" })).document.verdict).toBe("pass");
  });

  it("forgery signals, editing metadata and weak AI reads send a document to review", async () => {
    const s = await seed();
    setKycPorts(makePorts(s));
    const sess = await startKyc(s.actor);
    extraction = (t, g, p) => ({ ...good(t, g, p), forgerySignals: ["pasted-over GSTIN"], needsReview: true });
    expect((await upload(s, sess.id)).document.verdict).toBe("review");
    extraction = good;
    const edited = await uploadKycDocument(s.actor, sess.id, { docType: "gst_certificate", bytes: Buffer.from(`Adobe Photoshop ${randomUUID()}`), mimeType: "image/jpeg" });
    expect(edited.document.verdict).toBe("review");
    extraction = () => ({ fields: {}, forgerySignals: [], confidence: 0.1, needsReview: true }); // heuristic provider
    const empty = await upload(s, sess.id, "bank_proof");
    expect(empty.document.verdict).toBe("review");
    expect(empty.document.extracted).toEqual({});
  });

  it("rejects bad input, wrong owner/state and missing ports", async () => {
    const s = await seed(), other = await seed();
    expect(() => kycPorts()).toThrow(/not configured/);
    await expect(uploadKycDocument(s.actor, randomUUID(), { docType: "pan_card", bytes: png("x"), mimeType: "image/jpeg" })).rejects.toThrow(); // no ports
    setKycPorts(makePorts(s));
    const sess = await startKyc(s.actor);
    await expect(uploadKycDocument(s.actor, sess.id, { docType: "passport" as never, bytes: png("x"), mimeType: "image/jpeg" })).rejects.toThrow(/Unknown/);
    await expect(uploadKycDocument(s.actor, sess.id, { docType: "pan_card", bytes: new Uint8Array(1), mimeType: "image/jpeg" })).rejects.toThrow(/empty/);
    await expect(uploadKycDocument(other.actor, sess.id, { docType: "pan_card", bytes: png("x"), mimeType: "image/jpeg" })).rejects.toThrow(/not found/);
    await prisma.kycSession.update({ where: { id: sess.id }, data: { status: "approved" } });
    await expect(upload(s, sess.id)).rejects.toThrow(/no longer accepting/);
    const t = await prisma.kycSession.findUnique({ where: { id: sess.id } });
    expect(t).not.toBeNull();
    setKycPorts({ ...makePorts(s), inspectImage: () => { throw "boom"; } });
    await prisma.kycSession.update({ where: { id: sess.id }, data: { status: "initiated" } });
    await expect(upload(s, sess.id)).rejects.toThrow(/Invalid image/);
  });
});

describe("video KYC + completion", () => {
  it("approves: tier 2, both VerificationRecords, events, trust recomputed; docs purge later", async () => {
    const s = await seed();
    const id = await ready(s);
    const r = await beginVideoKyc(s.actor, id);
    expect(r.url).toBeNull(); // mock is instant
    expect(r.session.status).toBe("approved");
    const b = await prisma.business.findUniqueOrThrow({ where: { id: s.actor.businessId } });
    expect(b.verificationTier).toBe(2);
    expect(b.badgeActive).toBe(true);
    const recs = await prisma.verificationRecord.findMany({ where: { businessId: b.id, tier: 2 } });
    expect(recs.map((x) => x.kind).sort()).toEqual(["document", "video_kyc"]);
    expect(await events(id)).toEqual(["KycSubmitted", "KycDecided"]);
    expect(await prisma.domainEvent.count({ where: { aggregateId: b.id, type: "BusinessVerified" } })).toBe(1);
    expect(await completeKyc(id)).toEqual({ status: "approved", reasons: [] }); // idempotent
    await expect(beginVideoKyc(s.actor, id)).rejects.toThrow(/cannot start/);
  });

  it("begin: needs required docs, no failed docs, owner, and starts once", async () => {
    const s = await seed();
    setKycPorts(makePorts(s));
    const sess = await startKyc(s.actor);
    await expect(beginVideoKyc(s.actor, sess.id)).rejects.toThrow(/Upload these/);
    await upload(s, sess.id, "gst_certificate");
    extraction = (t, g, p) => (t === "pan_card" ? { ...good(t, g, p), fields: { pan: "ZZZZZ9999Z", name: "x" } } : good(t, g, p));
    await upload(s, sess.id, "pan_card");
    await expect(beginVideoKyc(s.actor, sess.id)).rejects.toThrow(/failed checks/);
    extraction = good;
    await upload(s, sess.id, "pan_card");
    // non-instant provider returns a link and waits
    const hosted = new MockKycProvider({ status: "pending" });
    Object.defineProperty(hosted, "instant", { value: false });
    setKycProvider(hosted);
    const r = await beginVideoKyc(s.actor, sess.id, { returnUrl: "https://seller/verification" });
    expect(r.url).toBe(`https://seller/verification?mockKyc=${sess.id}`);
    expect(r.session.status).toBe("in_progress");
    await expect(beginVideoKyc(s.actor, sess.id)).rejects.toThrow(/already started/);
    expect(await completeKyc(sess.id)).toEqual({ status: "pending" });
    hosted.result = { status: "passed", livenessScore: 0.95, faceMatchScore: 0.9 };
    expect((await completeKyc(sess.id)).status).toBe("approved");
    const [x, y] = [await seed(), await seed()];
    await expect(beginVideoKyc(y.actor, (await startKyc(x.actor)).id)).rejects.toThrow(/not found/);
  });

  it("rejects on provider failure; reviews on low liveness or review docs; then staff decide", async () => {
    // provider failed -> rejected
    const a = await seed();
    const ia = await ready(a);
    mock.result = { status: "failed", reasons: ["spoof_suspected"] };
    const ra = await beginVideoKyc(a.actor, ia);
    expect(ra.session.status).toBe("rejected");
    expect((await prisma.business.findUniqueOrThrow({ where: { id: a.actor.businessId } })).verificationTier).toBe(1);
    expect(await prisma.verificationRecord.count({ where: { businessId: a.actor.businessId, kind: "video_kyc", status: "failed" } })).toBe(1);
    mock.result = { status: "failed" };

    // low scores -> review -> staff approve
    const b = await seed();
    const ib = await ready(b);
    mock.result = { status: "passed", livenessScore: 0.5, faceMatchScore: 0.9 };
    expect((await beginVideoKyc(b.actor, ib)).session.status).toBe("review");
    expect(await events(ib)).toEqual(["KycSubmitted", "KycDecided"]);
    const queue = await listKycReviews();
    const item = queue.find((q) => q.id === ib)!;
    expect(item.businessName).toBe("Sharma Steel Private Limited".length ? b.biz.name : "");
    expect(item.declared.panMasked).toBe(`XXXXX${b.pan.slice(5)}`);
    expect(item.reasons.join()).toMatch(/below/);
    expect((await getKycReview(ib))!.documents).toHaveLength(2);
    expect(await getKycReview(randomUUID())).toBeNull();
    await expect(decideKyc(ib, "approved", "  ", "staff")).rejects.toThrow(/note/);
    await expect(decideKyc(randomUUID(), "approved", "ok", "staff")).rejects.toThrow(/not found/);
    expect(await decideKyc(ib, "approved", "Verified on call", randomUUID())).toEqual({ status: "approved" });
    expect((await prisma.business.findUniqueOrThrow({ where: { id: b.actor.businessId } })).verificationTier).toBe(2);
    await expect(decideKyc(ib, "rejected", "again", "staff")).rejects.toThrow(/not awaiting/);
    expect((await listKycReviews({ status: "approved" })).some((q) => q.id === ib)).toBe(true);

    // review doc -> review -> staff reject
    mock.result = { status: "passed", livenessScore: 0.99, faceMatchScore: 0.99 };
    const c = await seed();
    setKycPorts(makePorts(c));
    const sc = await startKyc(c.actor);
    extraction = (t, g, p) => (t === "pan_card" ? { ...good(t, g, p), fields: { pan: p, name: "Ramesh Kumar Verma" } } : good(t, g, p));
    await upload(c, sc.id, "gst_certificate");
    const pd = await upload(c, sc.id, "pan_card");
    expect(pd.document.verdict).toBe("review");
    expect((await beginVideoKyc(c.actor, sc.id)).session.status).toBe("review");
    expect(await decideKyc(sc.id, "rejected", "Name mismatch", randomUUID())).toEqual({ status: "rejected" });
    expect((await prisma.kycSession.findUniqueOrThrow({ where: { id: sc.id } })).reviewNote).toBe("Name mismatch");
    expect(await events(sc.id)).toEqual(["KycSubmitted", "KycDecided", "KycDecided"]);
  });

  it("completeKyc guards: unknown, not started, expired, missing docs, concurrent delivery", async () => {
    await expect(completeKyc(randomUUID())).rejects.toThrow(/not found/);
    const s = await seed();
    setKycPorts(makePorts(s));
    const sess = await startKyc(s.actor);
    await expect(completeKyc(sess.id)).rejects.toThrow(/not started/);
    await prisma.kycSession.update({ where: { id: sess.id }, data: { status: "in_progress", providerRef: `ref_${sess.id}`, expiresAt: new Date(Date.now() - 1000) } });
    await expect(completeKyc(sess.id)).rejects.toThrow(/expired/);
    expect((await prisma.kycSession.findUniqueOrThrow({ where: { id: sess.id } })).status).toBe("expired");

    // missing required docs (forced in_progress) -> rejected
    const m = await seed();
    const ms = await startKyc(m.actor);
    await prisma.kycSession.update({ where: { id: ms.id }, data: { status: "in_progress", providerRef: `ref_${ms.id}` } });
    const rr = await completeKyc(ms.id);
    expect(rr.status).toBe("rejected");

    // two simultaneous deliveries approve exactly once
    const c = await seed();
    const ic = await ready(c);
    const hosted = new MockKycProvider({ status: "passed", livenessScore: 0.95, faceMatchScore: 0.9 });
    Object.defineProperty(hosted, "instant", { value: false });
    setKycProvider(hosted);
    await beginVideoKyc(c.actor, ic);
    await Promise.all([completeKyc(ic), completeKyc(ic)]);
    expect(await prisma.domainEvent.count({ where: { aggregateId: ic, type: "KycDecided" } })).toBe(1);
  });
});

describe("KYC webhook", () => {
  it("verifies the signature, ignores unknown refs, completes known ones", async () => {
    const s = await seed();
    const id = await ready(s);
    const hosted = new MockKycProvider({ status: "passed", livenessScore: 0.95, faceMatchScore: 0.9 });
    Object.defineProperty(hosted, "instant", { value: false });
    setKycProvider(hosted);
    await beginVideoKyc(s.actor, id);
    const body = JSON.stringify({ providerRef: `mock_${id}` });
    const sig = { "x-kyc-signature": signKycWebhook("mock-secret", body) };
    await expect(handleKycWebhook(body, {})).rejects.toThrow(/signature/);
    const unknown = JSON.stringify({ providerRef: "nope" });
    expect(await handleKycWebhook(unknown, { "x-kyc-signature": signKycWebhook("mock-secret", unknown) })).toEqual({ sessionId: null, status: "unknown_reference" });
    expect(await handleKycWebhook(body, sig)).toEqual({ sessionId: id, status: "approved" });
  });
});

describe("retention", () => {
  it("purges images + encrypted PAN of decided sessions past the cutoff, keeps masked audit data", async () => {
    const s = await seed();
    const id = await ready(s);
    await beginVideoKyc(s.actor, id);
    const docs = await prisma.kycDocument.findMany({ where: { sessionId: id } });
    const cutoffNow = new Date(Date.now() - KYC_RETENTION_DAYS * day);
    expect(await purgeKycDocuments(cutoffNow, { dryRun: true })).toBe(0); // decided just now
    await prisma.kycSession.update({ where: { id }, data: { completedAt: new Date(Date.now() - 100 * day) } });
    expect(await purgeKycDocuments(cutoffNow, { dryRun: true })).toBeGreaterThanOrEqual(2);
    expect(stored.size).toBe(2);
    expect(await purgeKycDocuments(cutoffNow)).toBeGreaterThanOrEqual(2);
    expect(stored.size).toBe(0);
    const after = await prisma.kycDocument.findMany({ where: { sessionId: id } });
    for (const d of after) {
      expect(d.storageKey).toBeNull();
      expect(d.extracted).not.toHaveProperty("panEnc");
      expect((d.extracted as { pan?: string }).pan).toMatch(/^XXXXX/);
    }
    expect(after.map((d) => d.id).sort()).toEqual(docs.map((d) => d.id).sort());
    expect(await purgeKycDocuments(cutoffNow)).toBe(0); // idempotent
    expect((await getKycSession(s.actor))!.documents.every((d) => !d.hasImage)).toBe(true);

    // expired sessions purge on expiresAt
    const e = await seed();
    setKycPorts(makePorts(e));
    const es = await startKyc(e.actor);
    await upload(e, es.id, "pan_card");
    await prisma.kycSession.update({ where: { id: es.id }, data: { status: "expired", expiresAt: new Date(Date.now() - 100 * day) } });
    expect(await purgeKycDocuments(cutoffNow)).toBeGreaterThanOrEqual(1);
  });
});

describe("edge paths", () => {
  it("delete failure of a superseded image is tolerated", async () => {
    const s = await seed();
    const p = makePorts(s);
    setKycPorts({ ...p, store: { ...p.store, delete: async () => { throw new Error("gone"); } } });
    const sess = await startKyc(s.actor);
    await upload(s, sess.id, "pan_card");
    expect((await upload(s, sess.id, "pan_card")).document.verdict).toBe("pass");
  });

  it("documents replaced after video start: failed doc rejects; provider failure without reasons", async () => {
    const s = await seed();
    const id = await ready(s);
    const hosted = new MockKycProvider({ status: "pending" });
    Object.defineProperty(hosted, "instant", { value: false });
    setKycProvider(hosted);
    await beginVideoKyc(s.actor, id);
    extraction = (t, g, p) => (t === "pan_card" ? { ...good(t, g, p), fields: { pan: "ZZZZZ9999Z", name: "x" } } : good(t, g, p));
    await upload(s, id, "pan_card");
    hosted.result = { status: "failed" };
    const r = await completeKyc(id);
    expect(r.status).toBe("rejected");
    expect((r as { reasons: string[] }).reasons.join()).toMatch(/pan_card: .*Video KYC failed\./);
  });

  it("staff views tolerate sparse rows and purge handles rows with only an encrypted PAN", async () => {
    const b = await prisma.business.create({ data: { name: `Bare ${tag}`, isSeller: false } });
    bizIds.push(b.id);
    const person = await prisma.person.create({ data: { email: `kyc-bare-${tag}-${randomUUID().slice(0, 4)}@example.test` } });
    personIds.push(person.id);
    const sess = await prisma.kycSession.create({ data: { businessId: b.id, personId: person.id, provider: "mock", status: "review", expiresAt: new Date(Date.now() + day) } });
    await prisma.kycDocument.create({ data: { sessionId: sess.id, docType: "pan_card", sha256: randomUUID(), storageKey: null, extracted: { pan: "XXXXX1234F", panEnc: "v1.x" } } });
    const item = (await getKycReview(sess.id))!;
    expect(item.reasons).toEqual([]);
    expect(item.declared.panMasked).toBeNull();
    expect(item.documents[0]!.reasons).toEqual([]);
    await prisma.kycSession.update({ where: { id: sess.id }, data: { status: "rejected", completedAt: new Date(Date.now() - 200 * day) } });
    expect(await purgeKycDocuments(new Date(Date.now() - KYC_RETENTION_DAYS * day))).toBeGreaterThanOrEqual(1);
    expect((await prisma.kycDocument.findFirstOrThrow({ where: { sessionId: sess.id } })).extracted).toEqual({ pan: "XXXXX1234F" });
  });
});
