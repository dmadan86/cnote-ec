import "server-only";
import { timingSafeEqual } from "node:crypto";
import { DomainError } from "@cnote/core";
import { completeGoogleSignIn, googleAuthorizationUrl, isGoogleConfigured, refreshSession, signOut } from "@cnote/identity";
import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "./action-result";
import { clearAuthCookies, oauthCookieName, safeNext, setAuthCookies } from "./cookies";
import { beginMfaChallenge } from "./mfa-flow";
import { appRealm, realmAuth, realmCookies } from "./realm";

const ctxOf = (req: NextRequest) => ({
  ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim() || null,
  userAgent: req.headers.get("user-agent"),
  ...realmAuth(),
});
const redirectTo = (req: NextRequest, path: string, status = 303) => NextResponse.redirect(new URL(path, req.nextUrl.origin), status);
const signInError = (req: NextRequest, error: string) => redirectTo(req, `/signin?error=${encodeURIComponent(error)}`);

/** State-changing POSTs must come from our own origin (defence in depth on top of SameSite=Lax). */
function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  return !origin || origin === req.nextUrl.origin;
}
const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Catch-all auth route. Mount in each app as `src/app/api/auth/[action]/route.ts`:
 *   export { authRoute as GET, authRoute as POST } from "@cnote/next-kit";
 * Actions: google (start), google-callback, refresh, signout.
 */
export async function authRoute(req: NextRequest, ctx: { params: Promise<{ action: string }> }): Promise<Response> {
  const { action } = await ctx.params;
  try {
    switch (action) {
      case "google":
        if (req.method === "GET") return await googleStart(req);
        break;
      case "google-callback":
        if (req.method === "GET") return await googleCallback(req);
        break;
      case "refresh":
        if (req.method === "POST") return await refresh(req);
        break;
      case "signout":
        if (req.method === "POST") return await signOutRoute(req);
        break;
      default:
        return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: action.startsWith("google") ? "GET" : "POST" } });
  } catch (err) {
    if (action.startsWith("google")) {
      if (!(err instanceof DomainError)) console.error(err);
      return signInError(req, err instanceof DomainError ? err.message : "Google sign-in failed. Please try again.");
    }
    return errorResponse(err);
  }
}

async function googleStart(req: NextRequest) {
  if (!isGoogleConfigured()) return signInError(req, "Google sign-in is not configured");
  const next = safeNext(req.nextUrl.searchParams.get("next"));
  const { url, state, codeVerifier, nonce } = await googleAuthorizationUrl(`${req.nextUrl.origin}/api/auth/google-callback`);
  const res = NextResponse.redirect(url, 303);
  // Lax (not Strict): the callback is a cross-site top-level navigation from Google.
  res.cookies.set({
    name: oauthCookieName(),
    value: JSON.stringify({ state, codeVerifier, nonce, next }),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/auth",
    maxAge: 10 * 60,
  });
  return res;
}

async function googleCallback(req: NextRequest) {
  const raw = req.cookies.get(oauthCookieName())?.value;
  let saved: { state?: string; codeVerifier?: string; nonce?: string; next?: string } = {};
  try {
    saved = raw ? JSON.parse(raw) : {};
  } catch {
    /* treated as missing */
  }
  const q = req.nextUrl.searchParams;
  const fail = (msg: string) => {
    const res = signInError(req, msg);
    res.cookies.delete({ name: oauthCookieName(), path: "/api/auth" });
    return res;
  };
  if (q.get("error")) return fail("Google sign-in was cancelled.");
  const code = q.get("code");
  const state = q.get("state");
  if (!code || !state || !saved.state || !saved.codeVerifier || !saved.nonce || !eq(state, saved.state)) return fail("Google sign-in expired. Please try again.");

  const tokens = await completeGoogleSignIn(
    { code, codeVerifier: saved.codeVerifier, nonce: saved.nonce, redirectUri: `${req.nextUrl.origin}/api/auth/google-callback` },
    ctxOf(req),
  );
  // Second factor due (always for admin, opt-in elsewhere): park the session behind the MFA step.
  const challenge = await beginMfaChallenge(tokens, saved.next);
  const res = redirectTo(req, challenge ? challenge.path : safeNext(saved.next));
  if (challenge) res.cookies.set(challenge.cookie);
  else setAuthCookies(res.cookies, tokens);
  res.cookies.delete({ name: oauthCookieName(), path: "/api/auth" });
  return res;
}

async function refresh(req: NextRequest) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const rt = req.cookies.get(realmCookies().refresh)?.value;
  try {
    if (!rt) throw new DomainError("unauthenticated", "Not signed in.");
    const tokens = await refreshSession(rt, ctxOf(req));
    const res = NextResponse.json({ ok: true, accessExpiresAt: tokens.accessExpiresAt });
    setAuthCookies(res.cookies, tokens);
    return res;
  } catch (err) {
    const res = errorResponse(err);
    if (err instanceof DomainError && err.code === "unauthenticated") clearAuthCookies(res.cookies);
    return res;
  }
}

async function signOutRoute(req: NextRequest) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const rt = req.cookies.get(realmCookies().refresh)?.value;
  if (rt) await signOut(rt, appRealm());
  const res = redirectTo(req, "/");
  clearAuthCookies(res.cookies);
  return res;
}
