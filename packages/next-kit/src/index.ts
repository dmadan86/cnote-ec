// @cnote/next-kit — Next.js integration shared by apps/web, apps/seller and apps/admin:
// cookie-based sessions on top of @cnote/identity, auth route handlers, server actions, and
// action/route error helpers. Server-only entry; client components live in "@cnote/next-kit/client",
// the token-refresh proxy in "@cnote/next-kit/proxy".
// PUBLIC CONTRACT — apps depend on these signatures. Extend, don't break.
import "server-only";
import "./bootstrap";

export * from "./action-result";
export { appRealm, realmAuth, realmCookies } from "./realm";
export { currentSession, requireSession, requireBusiness, actorOf, requestContext, type SessionWithBusiness } from "./session";
export { safeNext, setAuthCookies, clearAuthCookies } from "./cookies";

/**
 * Catch-all auth route. Mount in each app as `src/app/api/auth/[action]/route.ts`:
 *   export { authRoute as GET, authRoute as POST } from "@cnote/next-kit";
 * Actions: google (start), google-callback, refresh, signout.
 */
export { authRoute } from "./route";

// Server actions ("use server" in their own module), used by the client forms.
export { signInAction, signUpAction, forgotPasswordAction, resetPasswordAction, signOutAction } from "./actions";

// Owned by parallel work streams.
export * from "./otp";
export * from "./security";
export * from "./human";
export { getMfaPending, getMfaEnrollmentInfo, MFA_PATH, mfaPendingCookieName, type MfaPendingView, type MfaMode } from "./mfa-flow";
