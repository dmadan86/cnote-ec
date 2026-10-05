// DPDP s.14 / Rules r.14: nominee (add / change / revoke with step-up, encrypted at rest) and the nominee's request workflow.
import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { describe, expect, it } from "vitest";
import {
  addNominee, changeNominee, completeNomineeRequest, decideNomineeRequest, deleteNomineesForPerson, exportNomineeData, fileNomineeRequest, getNomineeRequest, listMyNominees,
  listNomineeRequests, MAX_ACTIVE_NOMINEES, normalizeContact, purgeDecidedNomineeRequests, revokeNominee,
} from "../src";

const STAFF = randomUUID();
/** A person whose phone was verified just now: identity's step-up accepts a fresh OTP. */
async function person() {
  const id = randomUUID();
  await prisma.person.create({ data: { id, email: `nom-${id.slice(0, 8)}@example.com`, phone: `+9199${Math.floor(10_000_000 + Math.random() * 89_999_999)}`, phoneVerifiedAt: new Date() } });
  return id;
}
const stale = async (id: string) => void (await prisma.person.update({ where: { id }, data: { phoneVerifiedAt: new Date(Date.now() - 3_600_000) } }));
const nominee = (o: Partial<{ name: string; relationship: "spouse"; contact: string }> = {}) => ({ name: "Meera Rao", relationship: "spouse" as const, contact: `meera-${randomUUID().slice(0, 6)}@example.com`, ...o });

describe("normalizeContact", () => {
  it("lower-cases emails and canonicalises Indian mobiles", () => {
    expect(normalizeContact("  Meera@Example.COM ")).toBe("meera@example.com");
    expect(normalizeContact("98765 43210")).toBe("+919876543210");
    expect(normalizeContact("+91 98765-43210")).toBe("+919876543210");
    expect(normalizeContact("919876543210")).toBe("+919876543210");
  });
});

describe("managing nominees", () => {
  it("adds a nominee behind step-up, stores every field encrypted, and lists it back decrypted for the owner only", async () => {
    const p = await person();
    const input = nominee({ name: "Meera Rao" });
    const v = await addNominee(p, input, {});
    expect(v).toMatchObject({ name: "Meera Rao", relationship: "spouse", contact: input.contact.toLowerCase() });
    const row = await prisma.dataNominee.findUniqueOrThrow({ where: { id: v.id } });
    for (const c of [row.nameEnc, row.contactEnc, row.relationshipEnc]) expect(c.split(".")[0]).toMatch(/^v\d+$/);
    expect(JSON.stringify(row)).not.toContain("Meera");
    expect(JSON.stringify(row)).not.toContain(input.contact);
    expect(row.contactIndex).toMatch(/^[a-f0-9]{64}$/);
    expect((await listMyNominees(p)).map((n) => n.id)).toEqual([v.id]);
    expect(await listMyNominees(await person())).toEqual([]);
    expect(await prisma.domainEvent.findFirst({ where: { type: "DataNomineeChanged", aggregateId: p } })).toMatchObject({ payload: { personId: p, nomineeId: v.id, change: "added" } });
  });
  it("requires step-up for add, change and revoke (a stale session is not enough)", async () => {
    const p = await person();
    const v = await addNominee(p, nominee(), {});
    await stale(p);
    await expect(addNominee(p, nominee(), {})).rejects.toMatchObject({ code: "forbidden" });
    await expect(changeNominee(p, v.id, nominee(), {})).rejects.toMatchObject({ code: "forbidden" });
    await expect(revokeNominee(p, v.id, {})).rejects.toMatchObject({ code: "forbidden" });
    expect(await listMyNominees(p)).toHaveLength(1);
  });
  it("validates input, refuses self-nomination and duplicates, and caps the number of nominees", async () => {
    const p = await person();
    await expect(addNominee(p, { ...nominee(), name: "x" }, {})).rejects.toThrow();
    await expect(addNominee(p, { ...nominee(), contact: "not a contact" }, {})).rejects.toThrow();
    const own = await prisma.person.findUniqueOrThrow({ where: { id: p } });
    await expect(addNominee(p, nominee({ contact: own.email! }), {})).rejects.toMatchObject({ code: "validation" });
    const first = nominee();
    await addNominee(p, first, {});
    await expect(addNominee(p, nominee({ contact: first.contact.toUpperCase() }), {})).rejects.toMatchObject({ code: "conflict" });
    for (let i = 1; i < MAX_ACTIVE_NOMINEES; i++) await addNominee(p, nominee(), {});
    await expect(addNominee(p, nominee(), {})).rejects.toMatchObject({ code: "conflict" });
  });
  it("changes a nominee in place and revokes: details are wiped at once, the tombstone stays", async () => {
    const p = await person();
    const v = await addNominee(p, nominee(), {});
    const changed = await changeNominee(p, v.id, nominee({ name: "Meera R. Rao" }), {});
    expect(changed).toMatchObject({ id: v.id, name: "Meera R. Rao" });
    await expect(changeNominee(await person(), v.id, nominee(), {})).rejects.toMatchObject({ code: "not_found" }); // someone else's nominee
    await revokeNominee(p, v.id, {});
    expect(await listMyNominees(p)).toEqual([]);
    const row = await prisma.dataNominee.findUniqueOrThrow({ where: { id: v.id } });
    expect(row).toMatchObject({ status: "revoked", contactIndex: "revoked" });
    expect(row.revokedAt).not.toBeNull();
    await expect(revokeNominee(p, v.id, {})).rejects.toMatchObject({ code: "not_found" });
    expect((await prisma.domainEvent.findMany({ where: { type: "DataNomineeChanged", aggregateId: p }, orderBy: { id: "asc" } })).map((e) => (e.payload as { change: string }).change)).toEqual(["added", "changed", "revoked"]);
  });
  it("deleteNomineesForPerson (erasure of the principal) removes the nominations", async () => {
    const p = await person();
    await addNominee(p, nominee(), {});
    expect(await deleteNomineesForPerson(p)).toBe(1);
    expect(await prisma.dataNominee.count({ where: { personId: p } })).toBe(0);
  });
  it("exports the owner's nominations decrypted, without any requester details", async () => {
    const p = await person();
    const input = nominee();
    await addNominee(p, input, {});
    await fileNomineeRequest({ principalEmail: (await prisma.person.findUniqueOrThrow({ where: { id: p } })).email!, requesterName: "Meera Rao", requesterContact: input.contact, ground: "death", message: "Please help with the account." });
    const ex = (await exportNomineeData(p)) as { nominees: { items: { name: string }[] }; nomineeRequests: { items: Record<string, unknown>[] } };
    expect(ex.nominees.items[0]!.name).toBe("Meera Rao");
    expect(Object.keys(ex.nomineeRequests.items[0]!).sort()).toEqual(["actionTaken", "completedAt", "createdAt", "ground", "status"]);
  });
});

describe("nominee request workflow", () => {
  async function setup(opts: { matches?: boolean } = {}) {
    const p = await person();
    const n = nominee();
    await addNominee(p, n, {});
    const email = (await prisma.person.findUniqueOrThrow({ where: { id: p } })).email!;
    const req = await fileNomineeRequest({ principalEmail: email, requesterName: "Meera Rao", requesterContact: opts.matches === false ? "someone.else@example.com" : n.contact, ground: "death", message: "My husband passed away; please close the account." });
    return { p, n, email, req };
  }

  it("files a request: encrypted at rest, matched against the nomination, answer identical for an unknown account", async () => {
    const { req, p } = await setup();
    const row = await prisma.nomineeRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row).toMatchObject({ personId: p, nomineeMatched: true, status: "received", ground: "death" });
    expect(JSON.stringify(row)).not.toContain("Meera");
    expect(JSON.stringify(row)).not.toContain("passed away");
    expect(new Date(row.dueAt).getTime() - Date.now()).toBeGreaterThan(80 * 86_400_000); // 90-day rights-request clock
    const ghost = await fileNomineeRequest({ principalEmail: "nobody-here@example.com", requesterName: "Meera Rao", requesterContact: "x@example.com", ground: "incapacity", message: "Please help me with this account." });
    expect(Object.keys(ghost).sort()).toEqual(Object.keys(req).sort());
    expect(await prisma.nomineeRequest.findUniqueOrThrow({ where: { id: ghost.id } })).toMatchObject({ personId: null, nomineeMatched: false });
  });
  it("staff see the decrypted request next to the principal's registered nominees", async () => {
    const { req, n } = await setup();
    const d = await getNomineeRequest(req.id);
    expect(d).toMatchObject({ requesterName: "Meera Rao", requesterContact: n.contact.toLowerCase(), nomineeMatched: true, principalFound: true, status: "received" });
    expect(d!.registeredNominees).toEqual([{ name: "Meera Rao", relationship: "spouse", contactMatches: true }]);
    expect(d!.principal!.emailMasked).toMatch(/^n\*\*\*@example\.com$/);
    expect(await getNomineeRequest("not-a-uuid")).toBeNull();
    expect((await listNomineeRequests({ status: "received" })).some((r) => r.id === req.id)).toBe(true);
  });
  it("verifies only a requester who matches an active nomination; everything else can only be rejected", async () => {
    const miss = await setup({ matches: false });
    await expect(decideNomineeRequest(miss.req.id, "verified", "Death certificate checked", STAFF)).rejects.toMatchObject({ code: "validation" });
    await decideNomineeRequest(miss.req.id, "rejected", "Not a registered nominee", STAFF);
    expect((await getNomineeRequest(miss.req.id))!.status).toBe("rejected");
    await expect(decideNomineeRequest(miss.req.id, "rejected", "again please", STAFF)).rejects.toMatchObject({ code: "conflict" });
    // revoked in the meantime -> no longer verifiable
    const hit = await setup();
    const nom = (await listMyNominees(hit.p))[0]!;
    await revokeNominee(hit.p, nom.id, {});
    await expect(decideNomineeRequest(hit.req.id, "verified", "Death certificate checked", STAFF)).rejects.toMatchObject({ code: "validation" });
    // a note is mandatory
    const ok = await setup();
    await expect(decideNomineeRequest(ok.req.id, "verified", "", STAFF)).rejects.toThrow();
  });
  it("completes a verified request; erase_account erases the principal; an unverified one cannot be completed", async () => {
    const { p, req } = await setup();
    await expect(completeNomineeRequest(req.id, "erase_account", "done", STAFF)).rejects.toMatchObject({ code: "conflict" });
    await decideNomineeRequest(req.id, "verified", "Death certificate seen, matches the account holder", STAFF);
    await completeNomineeRequest(req.id, "erase_account", "Account erased at the nominee's request", STAFF);
    const done = await getNomineeRequest(req.id);
    expect(done).toMatchObject({ status: "completed", actionTaken: "erase_account" });
    expect((await prisma.person.findUniqueOrThrow({ where: { id: p } })).erasedAt).not.toBeNull();
    await expect(completeNomineeRequest(req.id, "other", "again", STAFF)).rejects.toMatchObject({ code: "conflict" });
    expect(await prisma.nomineeRequest.findUniqueOrThrow({ where: { id: req.id } })).toMatchObject({ reviewedBy: STAFF });
  });
  it("records non-destructive actions without touching the account", async () => {
    const { p, req } = await setup();
    await decideNomineeRequest(req.id, "verified", "Guardianship order seen", STAFF);
    await completeNomineeRequest(req.id, "release_export", "Export sent to the nominee by courier", STAFF);
    expect((await prisma.person.findUniqueOrThrow({ where: { id: p } })).erasedAt).toBeNull();
  });
  it("retention purges decided requests and revoked nominations after the window, not open ones", async () => {
    const { req } = await setup();
    const open = await setup();
    await decideNomineeRequest(req.id, "rejected", "Rejected for the test", STAFF, new Date(Date.now() - 4000 * 86_400_000));
    const before = new Date(Date.now() - 3000 * 86_400_000);
    expect(await purgeDecidedNomineeRequests(before, { dryRun: true })).toBeGreaterThanOrEqual(1);
    expect(await prisma.nomineeRequest.count({ where: { id: req.id } })).toBe(1);
    await purgeDecidedNomineeRequests(before);
    expect(await prisma.nomineeRequest.count({ where: { id: req.id } })).toBe(0);
    expect(await prisma.nomineeRequest.count({ where: { id: open.req.id } })).toBe(1);
  });
});
