import { randomUUID } from "node:crypto";
import { redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { beginMfaEnrollment, confirmMfaEnrollment } from "../src/mfa";
import {
  MAX_PASSKEYS_PER_PERSON, beginPasskeyAuthentication, beginPasskeyRegistration, countPasskeys, finishPasskeyAuthentication, finishPasskeyRegistration,
  listPasskeys, passkeyConfig, passkeyPolicy, passkeyRequired, passkeysEnabled, renamePasskey, resetPasskeys, revokePasskey, verifyPasskeyStepUp,
} from "../src/passkeys";
import { erasePerson, exportPersonalData } from "../src/privacy";
import { base32Decode, totp } from "../src/totp";
import { SoftwareAuthenticator } from "./support/software-authenticator";

const ORIGIN = "https://admin.passkeys.test";
const RP_ID = "admin.passkeys.test";
const ENV_KEYS = ["ADMIN_PASSKEYS_ENABLED", "ADMIN_REQUIRE_PASSKEY", "ADMIN_WEBAUTHN_RP_ID", "ADMIN_WEBAUTHN_ORIGIN", "ADMIN_APP_URL"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

const people: string[] = [];
async function newPerson() {
  const p = await prisma.person.create({ data: { email: `pk-${randomUUID()}@example.test` }, select: { id: true } });
  people.push(p.id);
  return p.id;
}
const authn = () => new SoftwareAuthenticator({ origin: ORIGIN, rpID: RP_ID });

async function enroll(personId: string, a = authn(), nickname?: string) {
  const options = await beginPasskeyRegistration("admin", personId, "staff@example.test");
  const view = await finishPasskeyRegistration("admin", personId, a.register(options.challenge) as never, nickname);
  return { a, view };
}
async function assertion(personId: string, a: SoftwareAuthenticator, o: Parameters<SoftwareAuthenticator["assert"]>[1] = {}) {
  const options = await beginPasskeyAuthentication("admin", personId);
  return a.assert(options.challenge, o) as never;
}
const fillCap = (personId: string, tag: string) =>
  prisma.personPasskey.createMany({
    data: Array.from({ length: MAX_PASSKEYS_PER_PERSON }, (_, i) => ({ personId, realm: "admin", credentialId: `${tag}-${personId}-${i}`, publicKey: Buffer.from([1]), aaguid: "x", deviceType: "singleDevice", nickname: `k${i}` })),
  });

beforeEach(() => {
  process.env.ADMIN_PASSKEYS_ENABLED = "1";
  process.env.ADMIN_WEBAUTHN_RP_ID = RP_ID;
  process.env.ADMIN_WEBAUTHN_ORIGIN = ORIGIN;
  delete process.env.ADMIN_REQUIRE_PASSKEY;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
afterAll(async () => {
  await prisma.personPasskey.deleteMany({ where: { personId: { in: people } } });
  await prisma.personMfa.deleteMany({ where: { personId: { in: people } } });
  await prisma.authSession.deleteMany({ where: { personId: { in: people } } });
  for (const pattern of ["rl:passkey:*", "webauthn:*", "rl:mfa:verify:*"]) {
    const keys = await redis.keys(pattern);
    if (keys.length) await redis.del(...keys);
  }
});

describe("passkey config", () => {
  it("is off unless enabled; require implies enabled", () => {
    expect(passkeysEnabled("admin", {})).toBe(false);
    expect(passkeyConfig("admin", {})).toBeNull();
    expect(passkeysEnabled("admin", { ADMIN_REQUIRE_PASSKEY: "1" })).toBe(true);
    expect(passkeyRequired("admin", { ADMIN_REQUIRE_PASSKEY: "true" })).toBe(true);
    expect(passkeyRequired("admin", {})).toBe(false);
  });
  it("derives localhost defaults outside production and demands explicit values in production", () => {
    expect(passkeyConfig("admin", { ADMIN_PASSKEYS_ENABLED: "1" })).toMatchObject({ rpID: "localhost", origin: "http://localhost:3001" });
    expect(passkeyConfig("admin", { ADMIN_PASSKEYS_ENABLED: "1", ADMIN_APP_URL: "http://127.0.0.1:3001/" })).toMatchObject({ rpID: "127.0.0.1", origin: "http://127.0.0.1:3001" });
    expect(passkeyConfig("admin", { ADMIN_PASSKEYS_ENABLED: "1", ADMIN_WEBAUTHN_ORIGIN: "https://a.example.com/", ADMIN_WEBAUTHN_RP_ID: "example.com" })).toEqual({ rpID: "example.com", origin: "https://a.example.com", rpName: "Cnote" });
    expect(() => passkeyConfig("admin", { NODE_ENV: "production", ADMIN_PASSKEYS_ENABLED: "1" })).toThrow("ADMIN_WEBAUTHN_RP_ID");
    expect(() => passkeyConfig("admin", { ADMIN_PASSKEYS_ENABLED: "1", ADMIN_WEBAUTHN_ORIGIN: "not a url" })).toThrow("ADMIN_WEBAUTHN_RP_ID");
  });
  it("other realms read their own prefix", () => {
    expect(passkeysEnabled("seller", { ADMIN_PASSKEYS_ENABLED: "1" })).toBe(false);
    expect(passkeyConfig("seller", { SELLER_PASSKEYS_ENABLED: "1", SELLER_WEBAUTHN_ORIGIN: "https://s.example.com", SELLER_WEBAUTHN_RP_ID: "s.example.com" })?.rpID).toBe("s.example.com");
  });
  it("operations refuse when passkeys are disabled", async () => {
    delete process.env.ADMIN_PASSKEYS_ENABLED;
    await expect(beginPasskeyRegistration("admin", randomUUID(), "x")).rejects.toThrow("not enabled");
  });
  it("passkeyPolicy reflects env and DB", async () => {
    const id = await newPerson();
    expect(await passkeyPolicy("admin", id)).toEqual({ enabled: true, required: false, hasPasskey: false });
    await enroll(id);
    process.env.ADMIN_REQUIRE_PASSKEY = "1";
    expect(await passkeyPolicy("admin", id)).toEqual({ enabled: true, required: true, hasPasskey: true });
    delete process.env.ADMIN_PASSKEYS_ENABLED;
    delete process.env.ADMIN_REQUIRE_PASSKEY;
    expect(await passkeyPolicy("admin", id)).toEqual({ enabled: false, required: false, hasPasskey: false });
  });
});

describe("registration", () => {
  it("registers a software authenticator, stores metadata, emits an event", async () => {
    const id = await newPerson();
    const { view } = await enroll(id, authn(), "  Work <b>laptop</b>  ");
    expect(view).toMatchObject({ nickname: "Work blaptop/b", transports: ["internal"], lastUsedAt: null });
    expect(await listPasskeys("admin", id)).toHaveLength(1);
    expect(await listPasskeys("seller", id)).toHaveLength(0);
    expect(await prisma.domainEvent.findFirst({ where: { type: "PasskeyRegistered", aggregateId: id } })).not.toBeNull();
    const row = await prisma.personPasskey.findFirstOrThrow({ where: { personId: id } });
    expect(row.publicKey.length).toBeGreaterThan(30);
    expect(row.signCount).toBe(0n);
  });
  it("default nickname counts up", async () => {
    const id = await newPerson();
    expect((await enroll(id)).view.nickname).toBe("Passkey 1");
    expect((await enroll(id)).view.nickname).toBe("Passkey 2");
  });
  it("challenge is single use", async () => {
    const id = await newPerson();
    const options = await beginPasskeyRegistration("admin", id, "s@example.test");
    const resp = authn().register(options.challenge) as never;
    await finishPasskeyRegistration("admin", id, resp);
    await expect(finishPasskeyRegistration("admin", id, resp)).rejects.toThrow("expired");
  });
  it("rejects a wrong origin, a wrong rpId and a wrong challenge", async () => {
    const id = await newPerson();
    const a = authn();
    let o = await beginPasskeyRegistration("admin", id, "s@example.test");
    await expect(finishPasskeyRegistration("admin", id, a.register(o.challenge, { origin: "https://evil.test" }) as never)).rejects.toThrow("could not be verified");
    o = await beginPasskeyRegistration("admin", id, "s@example.test");
    await expect(finishPasskeyRegistration("admin", id, a.register(o.challenge, { rpID: "evil.test" }) as never)).rejects.toThrow("could not be verified");
    o = await beginPasskeyRegistration("admin", id, "s@example.test");
    await expect(finishPasskeyRegistration("admin", id, a.register("AAAA") as never)).rejects.toThrow("could not be verified");
    expect(await countPasskeys("admin", id)).toBe(0);
  });
  it("rejects an authenticator that did not verify the user", async () => {
    const id = await newPerson();
    const a = new SoftwareAuthenticator({ origin: ORIGIN, rpID: RP_ID, userVerified: false });
    const o = await beginPasskeyRegistration("admin", id, "s@example.test");
    await expect(finishPasskeyRegistration("admin", id, a.register(o.challenge) as never)).rejects.toThrow("could not be verified");
  });
  it("refuses a duplicate credential and excludes existing ones from the options", async () => {
    const id = await newPerson();
    const { a } = await enroll(id);
    const o = await beginPasskeyRegistration("admin", id, "s@example.test");
    expect(o.excludeCredentials).toHaveLength(1);
    await expect(finishPasskeyRegistration("admin", id, a.register(o.challenge) as never)).rejects.toThrow("already registered");
    const other = await newPerson();
    const o2 = await beginPasskeyRegistration("admin", other, "o@example.test");
    await expect(finishPasskeyRegistration("admin", other, a.register(o2.challenge) as never)).rejects.toThrow("already registered");
  });
  it(`caps at ${MAX_PASSKEYS_PER_PERSON} passkeys`, async () => {
    const id = await newPerson();
    await fillCap(id, "cap");
    await expect(beginPasskeyRegistration("admin", id, "s@example.test")).rejects.toThrow("at most");
  });
  it("finish re-checks the cap when slots were taken meanwhile", async () => {
    const id = await newPerson();
    const o = await beginPasskeyRegistration("admin", id, "s@example.test");
    await fillCap(id, "race");
    await expect(finishPasskeyRegistration("admin", id, authn().register(o.challenge) as never)).rejects.toThrow("at most");
  });
});

describe("authentication", () => {
  it("verifies an assertion, advances the counter, stamps lastUsedAt", async () => {
    const id = await newPerson();
    const { a, view } = await enroll(id);
    const o = await beginPasskeyAuthentication("admin", id);
    expect(o.allowCredentials).toHaveLength(1);
    expect(o.userVerification).toBe("required");
    expect(await finishPasskeyAuthentication("admin", id, a.assert(o.challenge) as never)).toEqual({ passkeyId: view.id });
    const row = await prisma.personPasskey.findUniqueOrThrow({ where: { id: view.id } });
    expect(row.signCount).toBe(1n);
    expect(row.lastUsedAt).not.toBeNull();
    await finishPasskeyAuthentication("admin", id, await assertion(id, a));
    expect((await prisma.personPasskey.findUniqueOrThrow({ where: { id: view.id } })).signCount).toBe(2n);
  });
  it("accepts authenticators that always report counter 0", async () => {
    const id = await newPerson();
    const { a } = await enroll(id);
    for (let i = 0; i < 2; i++) await finishPasskeyAuthentication("admin", id, await assertion(id, a, { counter: 0 }));
  });
  it("needs an existing passkey to begin", async () => {
    await expect(beginPasskeyAuthentication("admin", await newPerson())).rejects.toThrow("No passkey");
  });
  it("challenge is single use (replay of the same assertion fails)", async () => {
    const id = await newPerson();
    const { a } = await enroll(id);
    const resp = await assertion(id, a);
    await finishPasskeyAuthentication("admin", id, resp);
    await expect(finishPasskeyAuthentication("admin", id, resp)).rejects.toThrow("Passkey verification failed");
  });
  it("rejects bad signature, wrong origin, wrong rpId, other person's credential, unknown credential, no challenge", async () => {
    const id = await newPerson();
    const { a } = await enroll(id);
    for (const b of [{ tamper: true }, { origin: "https://evil.test" }, { rpID: "evil.test" }]) {
      await expect(finishPasskeyAuthentication("admin", id, await assertion(id, a, b))).rejects.toThrow("Passkey verification failed");
    }
    const other = await newPerson();
    const { a: otherAuth } = await enroll(other);
    await expect(finishPasskeyAuthentication("admin", id, await assertion(id, otherAuth))).rejects.toThrow("Passkey verification failed");
    const unknown = { ...((await assertion(id, a)) as object), id: "nope" } as never;
    await expect(finishPasskeyAuthentication("admin", id, unknown)).rejects.toThrow("Passkey verification failed");
    await expect(finishPasskeyAuthentication("admin", id, a.assert("AAAA") as never)).rejects.toThrow("Passkey verification failed");
    await expect(finishPasskeyAuthentication("admin", id, {} as never)).rejects.toThrow("Passkey verification failed");
  });
  it("a bad signature never touches the counter or revokes", async () => {
    const id = await newPerson();
    const { a, view } = await enroll(id);
    await expect(finishPasskeyAuthentication("admin", id, await assertion(id, a, { counter: 0, tamper: true }))).rejects.toThrow();
    const row = await prisma.personPasskey.findUniqueOrThrow({ where: { id: view.id } });
    expect(row.revokedAt).toBeNull();
    expect(row.signCount).toBe(0n);
  });
  it("revoked passkeys cannot sign in", async () => {
    const id = await newPerson();
    const { a, view } = await enroll(id);
    const resp = await assertion(id, a);
    await prisma.personPasskey.update({ where: { id: view.id }, data: { revokedAt: new Date() } });
    await expect(finishPasskeyAuthentication("admin", id, resp)).rejects.toThrow("Passkey verification failed");
  });
  it("sign-count regression revokes the credential, emits events and throws", async () => {
    const id = await newPerson();
    const { a, view } = await enroll(id);
    for (let i = 0; i < 3; i++) await finishPasskeyAuthentication("admin", id, await assertion(id, a));
    await expect(finishPasskeyAuthentication("admin", id, await assertion(id, a, { counter: 2 }))).rejects.toThrow("may have been copied");
    const row = await prisma.personPasskey.findUniqueOrThrow({ where: { id: view.id } });
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokedReason).toBe("clone_suspected");
    const evs = await prisma.domainEvent.findMany({ where: { aggregateId: id, type: { in: ["PasskeyCloneSuspected", "PasskeyRevoked"] } } });
    expect(evs.map((e) => e.type).sort()).toEqual(["PasskeyCloneSuspected", "PasskeyRevoked"]);
    expect(evs.find((e) => e.type === "PasskeyCloneSuspected")?.payload).toMatchObject({ storedCount: 3, receivedCount: 2 });
    expect(await countPasskeys("admin", id)).toBe(0);
  });
  it("an equal non-zero counter is a regression too", async () => {
    const id = await newPerson();
    const { a } = await enroll(id);
    await finishPasskeyAuthentication("admin", id, await assertion(id, a));
    await expect(finishPasskeyAuthentication("admin", id, await assertion(id, a, { counter: 1 }))).rejects.toThrow("may have been copied");
  });
  it("a concurrent use that loses the compare-and-swap is rejected without revoking", async () => {
    const id = await newPerson();
    const { a, view } = await enroll(id);
    const resp = await assertion(id, a, { counter: 5 });
    const model = prisma.personPasskey as unknown as { findUnique: (args: never) => Promise<unknown> };
    const original = model.findUnique;
    model.findUnique = async function (this: unknown, args: never) {
      const row = await original.call(prisma.personPasskey, args);
      await prisma.personPasskey.update({ where: { id: view.id }, data: { signCount: 1n } }); // another request advanced it
      return row;
    };
    try {
      await expect(finishPasskeyAuthentication("admin", id, resp)).rejects.toThrow("Passkey verification failed");
    } finally {
      model.findUnique = original;
    }
    expect((await prisma.personPasskey.findUniqueOrThrow({ where: { id: view.id } })).revokedAt).toBeNull();
  });
});

describe("manage", () => {
  it("renames (sanitised) and refuses an unknown passkey or an empty name", async () => {
    const id = await newPerson();
    const { view } = await enroll(id);
    await renamePasskey("admin", id, view.id, "YubiKey 5C");
    expect((await listPasskeys("admin", id))[0]?.nickname).toBe("YubiKey 5C");
    await expect(renamePasskey("admin", id, view.id, "  <>  ")).rejects.toThrow("Enter a name");
    await expect(renamePasskey("admin", await newPerson(), view.id, "x")).rejects.toThrow("not found");
  });
  it("revoke needs step-up: an assertion (or a TOTP code)", async () => {
    const id = await newPerson();
    const { a, view } = await enroll(id);
    const { view: v2 } = await enroll(id);
    await expect(revokePasskey("admin", id, view.id, undefined)).rejects.toThrow("Confirm it is you");
    await expect(revokePasskey("admin", id, view.id, { code: "123456" })).rejects.toThrow(); // no TOTP enrolled
    await revokePasskey("admin", id, view.id, { assertion: await assertion(id, a) });
    expect((await listPasskeys("admin", id)).map((k) => k.id)).toEqual([v2.id]);
    const ev = await prisma.domainEvent.findFirst({ where: { aggregateId: id, type: "PasskeyRevoked" } });
    expect(ev?.payload).toMatchObject({ reason: "user", passkeyId: view.id });
  });
  it("revoking a passkey that is already gone is not_found", async () => {
    const id = await newPerson();
    const { a, view } = await enroll(id);
    await enroll(id);
    await prisma.personPasskey.update({ where: { id: view.id }, data: { revokedAt: new Date() } });
    await expect(revokePasskey("admin", id, view.id, { assertion: await assertion(id, (await enroll(id)).a) })).rejects.toThrow("not found");
    void a;
  });
  it("revoke with an authenticator code works when passkeys are optional", async () => {
    const id = await newPerson();
    const { view } = await enroll(id);
    const { otpauthUri } = await beginMfaEnrollment(id, "x@example.test");
    const secret = base32Decode(new URL(otpauthUri).searchParams.get("secret")!);
    await confirmMfaEnrollment(id, totp(secret, Date.now()));
    await revokePasskey("admin", id, view.id, { code: totp(secret, Date.now() + 30_000) });
    expect(await countPasskeys("admin", id)).toBe(0);
  });
  it("with the policy on: the last passkey cannot be removed and TOTP cannot be used for step-up", async () => {
    const id = await newPerson();
    const { a, view } = await enroll(id);
    process.env.ADMIN_REQUIRE_PASSKEY = "1";
    await expect(revokePasskey("admin", id, view.id, { code: "123456" })).rejects.toThrow("requires a passkey");
    await enroll(id);
    await expect(verifyPasskeyStepUp("admin", id, { code: "123456" })).rejects.toThrow("Use your passkey");
    await expect(verifyPasskeyStepUp("admin", id, { assertion: await assertion(id, a) })).resolves.toBeUndefined();
  });
  it("resetPasskeys revokes everything, emits per-key events and signs the person out", async () => {
    const id = await newPerson();
    await enroll(id);
    await enroll(id);
    const staff = randomUUID();
    expect(await resetPasskeys("admin", id, staff)).toBe(2);
    expect(await countPasskeys("admin", id)).toBe(0);
    const rows = await prisma.personPasskey.findMany({ where: { personId: id } });
    expect(rows.every((r) => r.revokedReason === "reset")).toBe(true);
    const evs = await prisma.domainEvent.findMany({ where: { aggregateId: id, type: "PasskeyRevoked" } });
    expect(evs).toHaveLength(2);
    expect(evs[0]?.payload).toMatchObject({ reason: "reset", byStaffId: staff });
    expect(await resetPasskeys("admin", id, staff)).toBe(0);
  });
});

describe("privacy", () => {
  it("export lists passkey metadata without key material; erasure deletes the rows", async () => {
    const id = await newPerson();
    await enroll(id);
    const data = await exportPersonalData(id);
    const pk = (data.passkeys as Record<string, unknown>[])[0]!;
    expect(pk).toMatchObject({ realm: "admin" });
    expect(JSON.stringify(pk)).not.toMatch(/publicKey|credentialId/);
    await erasePerson(id);
    expect(await prisma.personPasskey.count({ where: { personId: id } })).toBe(0);
  });
});
