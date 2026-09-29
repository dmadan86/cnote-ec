// Google OAuth: ID-token verification against a locally generated JWKS, PKCE URL, code exchange with mocked fetch, account linking.
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { prisma } from "@cnote/db";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { completeGoogleSignIn, getSession, googleAuthorizationUrl, isGoogleConfigured } from "../src";
import { upsertGoogleUser, verifyGoogleIdToken } from "../src/google";

const CLIENT = "client-123.apps.googleusercontent.com";
const made: string[] = [];
let priv: CryptoKey, otherPriv: CryptoKey, jwks: ReturnType<typeof createLocalJWKSet>, jwk: JWK;

beforeAll(async () => {
  const a = await generateKeyPair("RS256");
  const b = await generateKeyPair("RS256");
  priv = a.privateKey as CryptoKey;
  otherPriv = b.privateKey as CryptoKey;
  jwk = { ...(await exportJWK(a.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  jwks = createLocalJWKSet({ keys: [jwk] });
});
afterAll(async () => {
  await prisma.authSession.deleteMany({ where: { personId: { in: made } } });
  await prisma.authIdentity.deleteMany({ where: { personId: { in: made } } });
  await prisma.consent.deleteMany({ where: { personId: { in: made } } });
  await prisma.person.deleteMany({ where: { id: { in: made } } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

interface Over { iss?: string; aud?: string; exp?: number | string; sub?: string | null; email?: unknown; email_verified?: unknown; name?: unknown; picture?: unknown; key?: CryptoKey; alg?: string; kid?: string; nonce?: string }
async function idToken(o: Over = {}) {
  const claims: Record<string, unknown> = { email: "user@example.test", email_verified: true, name: "G User", picture: "https://x/p.png", ...("email" in o ? { email: o.email } : {}), ...("email_verified" in o ? { email_verified: o.email_verified } : {}), ...("name" in o ? { name: o.name } : {}), ...("picture" in o ? { picture: o.picture } : {}), ...("nonce" in o ? { nonce: o.nonce } : {}) };
  let j = new SignJWT(claims).setProtectedHeader({ alg: o.alg ?? "RS256", kid: o.kid ?? "k1" }).setIssuer(o.iss ?? "https://accounts.google.com").setAudience(o.aud ?? CLIENT).setIssuedAt();
  if (o.sub !== null) j = j.setSubject(o.sub ?? "google-sub-1");
  j = j.setExpirationTime(o.exp ?? "1h");
  return j.sign(o.key ?? priv);
}

describe("verifyGoogleIdToken nonce binding", () => {
  it("accepts a token carrying the nonce we sent", async () => {
    expect(await verifyGoogleIdToken(await idToken({ nonce: "n-123" }), CLIENT, jwks, "n-123")).toMatchObject({ sub: "google-sub-1" });
  });
  it("rejects a token with a different or missing nonce when one is expected (replay protection)", async () => {
    await expect(verifyGoogleIdToken(await idToken({ nonce: "n-other" }), CLIENT, jwks, "n-123")).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(verifyGoogleIdToken(await idToken(), CLIENT, jwks, "n-123")).rejects.toMatchObject({ code: "unauthenticated" });
  });
  it("puts a fresh nonce in every authorization URL", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT);
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "s");
    const a = await googleAuthorizationUrl("http://localhost/cb");
    const b = await googleAuthorizationUrl("http://localhost/cb");
    expect(new URL(a.url).searchParams.get("nonce")).toBe(a.nonce);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.nonce.length).toBeGreaterThanOrEqual(24);
  });
});

describe("verifyGoogleIdToken", () => {
  it("accepts a valid token from either Google issuer form and lower-cases the email", async () => {
    expect(await verifyGoogleIdToken(await idToken({ email: "User@Example.TEST" }), CLIENT, jwks)).toEqual({ sub: "google-sub-1", email: "user@example.test", name: "G User", picture: "https://x/p.png" });
    expect(await verifyGoogleIdToken(await idToken({ iss: "accounts.google.com" }), CLIENT, jwks)).toMatchObject({ sub: "google-sub-1" });
  });
  it("drops non-string name/picture", async () => {
    const c = await verifyGoogleIdToken(await idToken({ name: 5, picture: { a: 1 } }), CLIENT, jwks);
    expect(c.name).toBeUndefined();
    expect(c.picture).toBeUndefined();
  });
  it.each<[string, Over]>([
    ["wrong issuer", { iss: "https://evil.example" }],
    ["wrong audience", { aud: "someone-elses-client" }],
    ["expired", { exp: Math.floor(Date.now() / 1000) - 3600 }],
    ["signed by another key", { key: undefined }],
    ["unknown kid", { kid: "other" }],
  ])("rejects %s with the generic sign-in error", async (name, o) => {
    const token = name === "signed by another key" ? await idToken({ key: otherPriv }) : await idToken(o);
    await expect(verifyGoogleIdToken(token, CLIENT, jwks)).rejects.toMatchObject({ code: "unauthenticated", message: "Google sign-in failed. Please try again." });
  });
  it("rejects garbage, alg=none and HS256-confusion tokens", async () => {
    await expect(verifyGoogleIdToken("garbage", CLIENT, jwks)).rejects.toMatchObject({ code: "unauthenticated" });
    const none = `${Buffer.from('{"alg":"none","kid":"k1"}').toString("base64url")}.${Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud: CLIENT, sub: "s", email: "a@b.c", email_verified: true, exp: 9e9 })).toString("base64url")}.`;
    await expect(verifyGoogleIdToken(none, CLIENT, jwks)).rejects.toMatchObject({ code: "unauthenticated" });
    // attacker signs with HS256 using the (public) RSA modulus as the secret
    const hs = await new SignJWT({ email: "a@b.c", email_verified: true }).setProtectedHeader({ alg: "HS256", kid: "k1" }).setIssuer("https://accounts.google.com").setAudience(CLIENT).setSubject("s").setExpirationTime("1h").sign(new TextEncoder().encode(jwk.n!));
    await expect(verifyGoogleIdToken(hs, CLIENT, jwks)).rejects.toMatchObject({ code: "unauthenticated" });
  });
  it.each<[string, Over]>([
    ["email_verified false", { email_verified: false }],
    ["email_verified as string 'true'", { email_verified: "true" }],
    ["email_verified missing", { email_verified: undefined }],
    ["email missing", { email: undefined }],
    ["email not a string", { email: 42 }],
    ["sub missing", { sub: null }],
  ])("rejects %s", async (_n, o) => {
    await expect(verifyGoogleIdToken(await idToken(o), CLIENT, jwks)).rejects.toMatchObject({ code: "unauthenticated", message: "Your Google account email is not verified." });
  });
});

describe("authorization URL + config", () => {
  it("builds an S256 PKCE URL whose challenge matches the returned verifier, with unique state per call", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT);
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "s3cret");
    const a = await googleAuthorizationUrl("https://app.test/api/auth/google/callback");
    const b = await googleAuthorizationUrl("https://app.test/api/auth/google/callback");
    const q = new URL(a.url).searchParams;
    expect(new URL(a.url).origin + new URL(a.url).pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(q)).toMatchObject({ client_id: CLIENT, response_type: "code", redirect_uri: "https://app.test/api/auth/google/callback", scope: "openid email profile", state: a.state, code_challenge_method: "S256" });
    expect(q.get("code_challenge")).toBe(createHash("sha256").update(a.codeVerifier).digest("base64url"));
    expect(a.state).not.toBe(b.state);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.codeVerifier.length).toBeGreaterThanOrEqual(43); // RFC 7636 minimum
    expect(a.url).not.toContain(a.codeVerifier);
    expect(a.url).not.toContain("s3cret");
  });
  it("isGoogleConfigured needs both id and secret; the URL/exchange fail clearly otherwise", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    expect(isGoogleConfigured()).toBe(false);
    await expect(googleAuthorizationUrl("https://x")).rejects.toMatchObject({ code: "validation" });
    await expect(completeGoogleSignIn({ code: "c", codeVerifier: "v", redirectUri: "r" }, { ip: null, userAgent: null })).rejects.toMatchObject({ code: "validation" });
    vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT);
    expect(isGoogleConfigured()).toBe(false);
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "x");
    expect(isGoogleConfigured()).toBe(true);
  });
});

describe("upsertGoogleUser (account linking)", () => {
  const claims = (over: Partial<{ sub: string; email: string; name: string; picture: string }> = {}) => ({ sub: `sub-${randomUUID()}`, email: `g-${randomUUID()}@example.test`, name: "N", picture: "p", ...over });
  it("creates a verified person, then logs in by (google, sub) even if the email changed", async () => {
    const c = claims();
    const a = await upsertGoogleUser(c);
    made.push(a.personId);
    expect(a.isNew).toBe(true);
    const p = await prisma.person.findUniqueOrThrow({ where: { id: a.personId } });
    expect(p).toMatchObject({ email: c.email, name: "N", avatarUrl: "p" });
    expect(p.emailVerifiedAt).not.toBeNull();
    const b = await upsertGoogleUser({ ...c, email: `changed-${randomUUID()}@example.test` });
    expect(b).toEqual({ personId: a.personId, isNew: false });
  });
  it("links to an existing VERIFIED-email person and keeps their password", async () => {
    const email = `link-${randomUUID()}@example.test`;
    const existing = await prisma.person.create({ data: { email, emailVerifiedAt: new Date(), passwordHash: "scrypt$keep", name: "Keep" } });
    made.push(existing.id);
    const r = await upsertGoogleUser(claims({ email, name: "Other" }));
    expect(r).toEqual({ personId: existing.id, isNew: false });
    const p = await prisma.person.findUniqueOrThrow({ where: { id: existing.id } });
    expect(p.passwordHash).toBe("scrypt$keep");
    expect(p.name).toBe("Keep"); // never overwrites existing profile data
    expect(await prisma.authIdentity.count({ where: { personId: existing.id, provider: "google" } })).toBe(1);
  });
  it("pre-hijack defence: linking to an UNVERIFIED-email person drops the impostor's password", async () => {
    const email = `pre-${randomUUID()}@example.test`;
    const existing = await prisma.person.create({ data: { email, passwordHash: "scrypt$impostor" } });
    made.push(existing.id);
    await upsertGoogleUser(claims({ email }));
    const p = await prisma.person.findUniqueOrThrow({ where: { id: existing.id } });
    expect(p.passwordHash).toBeNull();
    expect(p.emailVerifiedAt).not.toBeNull();
    expect(p.name).toBe("N");
    expect(p.avatarUrl).toBe("p");
  });
  it("refuses an erased person's Google identity", async () => {
    const c = claims();
    const a = await upsertGoogleUser(c);
    made.push(a.personId);
    await prisma.person.update({ where: { id: a.personId }, data: { erasedAt: new Date() } });
    await expect(upsertGoogleUser(c)).rejects.toMatchObject({ code: "unauthenticated", message: "This account has been deleted." });
  });
  it("creates without optional profile fields", async () => {
    const r = await upsertGoogleUser({ sub: `sub-${randomUUID()}`, email: `np-${randomUUID()}@example.test` });
    made.push(r.personId);
    expect(await prisma.person.findUniqueOrThrow({ where: { id: r.personId } })).toMatchObject({ name: null, avatarUrl: null });
  });
});

describe("completeGoogleSignIn (mocked token endpoint + JWKS)", () => {
  const ctx = { ip: "1.1.1.1", userAgent: "vitest" };
  function stubFetch(tokenRes: { ok?: boolean; body?: unknown }) {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.startsWith("https://www.googleapis.com/oauth2/v3/certs")) return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify(tokenRes.body ?? {}), { status: tokenRes.ok === false ? 400 : 200 });
    }));
    return calls;
  }
  it("exchanges the code with PKCE verifier, verifies the ID token and issues a realm session", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT);
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "s3cret");
    const email = `flow-${randomUUID()}@example.test`;
    const calls = stubFetch({ body: { id_token: await idToken({ email, sub: `sub-${randomUUID()}` }) } });
    const t = await completeGoogleSignIn({ code: "auth-code", codeVerifier: "verifier-xyz", redirectUri: "https://app/cb" }, { ...ctx, realm: "seller" });
    made.push(t.personId);
    expect(t.isNew).toBe(true);
    expect((await getSession(t.accessToken, "seller"))?.email).toBe(email);
    expect(await getSession(t.accessToken, "web")).toBeNull();
    const body = new URLSearchParams(String(calls.find((c) => c.url.includes("oauth2.googleapis.com/token"))!.init!.body));
    expect(Object.fromEntries(body)).toEqual({ code: "auth-code", client_id: CLIENT, client_secret: "s3cret", redirect_uri: "https://app/cb", grant_type: "authorization_code", code_verifier: "verifier-xyz" });
  });
  it("honours the admission guard (google sign-in cannot bypass staff-only realms)", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT);
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "s3cret");
    stubFetch({ body: { id_token: await idToken({ email: `guard-${randomUUID()}@example.test`, sub: `sub-${randomUUID()}` }) } });
    await expect(completeGoogleSignIn({ code: "c", codeVerifier: "v", redirectUri: "r" }, { ...ctx, realm: "admin", allowPerson: async (id) => { made.push(id); return false; } })).rejects.toMatchObject({ code: "unauthenticated" });
  });
  it("fails generically when the token endpoint errors, returns no id_token, or the id_token is bad", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT);
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "s3cret");
    stubFetch({ ok: false, body: { error: "invalid_grant" } });
    await expect(completeGoogleSignIn({ code: "c", codeVerifier: "v", redirectUri: "r" }, ctx)).rejects.toMatchObject({ code: "unauthenticated", message: "Google sign-in failed. Please try again." });
    stubFetch({ body: {} });
    await expect(completeGoogleSignIn({ code: "c", codeVerifier: "v", redirectUri: "r" }, ctx)).rejects.toMatchObject({ code: "unauthenticated" });
    stubFetch({ body: { id_token: await idToken({ aud: "other" }) } });
    await expect(completeGoogleSignIn({ code: "c", codeVerifier: "v", redirectUri: "r" }, ctx)).rejects.toMatchObject({ code: "unauthenticated" });
  });
});
