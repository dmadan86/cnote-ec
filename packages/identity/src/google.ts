import { createHash, timingSafeEqual } from "node:crypto";
import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { issueTokens } from "./sessions";
import { randomToken } from "./tokens";
import type { AuthContext, AuthTokens } from "./types";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

let jwks: JWTVerifyGetKey | undefined;
const googleJwks = () => (jwks ??= createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs")));

export function isGoogleConfigured(): boolean {
  return !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;
}
function creds() {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) throw new DomainError("validation", "Google sign-in is not configured");
  return { id, secret };
}

/**
 * Authorization code + PKCE (S256) + state + OIDC nonce. Caller keeps state/codeVerifier/nonce in a short-lived
 * httpOnly cookie; the nonce binds the returned ID token to this browser's sign-in attempt (replay protection).
 */
export async function googleAuthorizationUrl(redirectUri: string): Promise<{ url: string; state: string; codeVerifier: string; nonce: string }> {
  const { id } = creds();
  const state = randomToken(24);
  const nonce = randomToken(24);
  const codeVerifier = randomToken(48);
  const challenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    nonce,
    prompt: "select_account",
  }).toString();
  return { url: url.toString(), state, codeVerifier, nonce };
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface GoogleClaims {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
}

/**
 * Checks signature, iss, aud, exp (jose), email_verified and — when `expectedNonce` is given — that the token's
 * nonce matches the one we sent. `keys` is injectable for tests.
 */
export async function verifyGoogleIdToken(idToken: string, clientId: string, keys: JWTVerifyGetKey = googleJwks(), expectedNonce?: string): Promise<GoogleClaims> {
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, keys, { issuer: ISSUERS, audience: clientId }));
  } catch {
    throw new DomainError("unauthenticated", "Google sign-in failed. Please try again.");
  }
  if (expectedNonce !== undefined && (typeof payload.nonce !== "string" || !safeEqual(payload.nonce, expectedNonce))) {
    throw new DomainError("unauthenticated", "Google sign-in failed. Please try again.");
  }
  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : null;
  if (!payload.sub || !email || payload.email_verified !== true) {
    throw new DomainError("unauthenticated", "Your Google account email is not verified.");
  }
  return {
    sub: payload.sub,
    email,
    name: typeof payload.name === "string" ? payload.name : undefined,
    picture: typeof payload.picture === "string" ? payload.picture : undefined,
  };
}

/** Link by (google, sub); else by the same verified email; else create. Returns personId. */
export async function upsertGoogleUser(c: GoogleClaims): Promise<{ personId: string; isNew: boolean }> {
  const linked = await prisma.authIdentity.findUnique({
    where: { provider_providerSubject: { provider: "google", providerSubject: c.sub } },
    include: { person: { select: { id: true, erasedAt: true } } },
  });
  if (linked) {
    if (linked.person.erasedAt) throw new DomainError("unauthenticated", "This account has been deleted.");
    return { personId: linked.personId, isNew: false };
  }
  return prisma.$transaction(async (tx) => {
    const existing = await tx.person.findUnique({ where: { email: c.email } });
    if (existing) {
      await tx.authIdentity.create({ data: { personId: existing.id, provider: "google", providerSubject: c.sub, email: c.email } });
      // A password set while the email was unverified could belong to an impostor: drop it on first verified link.
      await tx.person.update({
        where: { id: existing.id },
        data: {
          emailVerifiedAt: existing.emailVerifiedAt ?? new Date(),
          ...(existing.emailVerifiedAt ? {} : { passwordHash: null }),
          name: existing.name ?? c.name,
          avatarUrl: existing.avatarUrl ?? c.picture,
        },
      });
      return { personId: existing.id, isNew: false };
    }
    const person = await tx.person.create({
      data: {
        email: c.email,
        emailVerifiedAt: new Date(),
        name: c.name ?? null,
        avatarUrl: c.picture ?? null,
        authIdentities: { create: { provider: "google", providerSubject: c.sub, email: c.email } },
      },
      select: { id: true },
    });
    return { personId: person.id, isNew: true };
  });
}

/** Exchanges the code, verifies the ID token, links/creates the Person. */
export async function completeGoogleSignIn(input: { code: string; codeVerifier: string; redirectUri: string; nonce?: string }, ctx: AuthContext): Promise<AuthTokens> {
  const { id, secret } = creds();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: input.code,
      client_id: id,
      client_secret: secret,
      redirect_uri: input.redirectUri,
      grant_type: "authorization_code",
      code_verifier: input.codeVerifier,
    }),
  });
  if (!res.ok) throw new DomainError("unauthenticated", "Google sign-in failed. Please try again.");
  const body = (await res.json()) as { id_token?: string };
  if (!body.id_token) throw new DomainError("unauthenticated", "Google sign-in failed. Please try again.");
  const claims = await verifyGoogleIdToken(body.id_token, id, undefined, input.nonce);
  const { personId, isNew } = await upsertGoogleUser(claims);
  return issueTokens(personId, ctx, isNew);
}
