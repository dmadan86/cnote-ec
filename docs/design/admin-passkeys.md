# Admin passkeys (WebAuthn)

Status: built, opt-in (`ADMIN_PASSKEYS_ENABLED`), enforceable (`ADMIN_REQUIRE_PASSKEY`). ADR-029 (auth realms + MFA), ADR-042 (security hardening). Controls: `docs/security/security-architecture.md` section 4.

## Why

Admin sign-in is password (or Google) plus TOTP. A look-alike page can relay both in real time, so TOTP is phishable, and the back office holds KYC documents, ledgers and moderation power. A passkey is bound to the real origin by the browser, so it cannot be replayed from a fake site.

## Scope

- Wired: admin realm only (`apps/admin`).
- Reusable: every function in `packages/identity/src/passkeys.ts` takes a `realm`; relying-party config is read from `<REALM>_WEBAUTHN_RP_ID`, `<REALM>_WEBAUTHN_ORIGIN`, `<REALM>_PASSKEYS_ENABLED`, `<REALM>_REQUIRE_PASSKEY`. The server actions in `@cnote/next-kit` (`mfa-actions.ts`) and the client components (`PasskeySignInButton`, `PasskeyEnrollPanel`, `PasskeySettings`) resolve the realm from `appRealm()`. To adopt it in seller or buyer: set the env, render the components on the account security page, and (for sign-in) pass `passkey`/`passkeyRequired` to `MfaChallengeForm`. `validateSecrets` already checks the `SELLER_`/`WEB_` variables for their own apps. Nothing else is realm specific except the AdminAuditLog writes, which are admin only.
- Not done: passwordless (usernameless) sign-in, attestation/AAGUID allow-listing, conditional UI autofill. The passkey is a second factor after the password; user verification is required, so one gesture proves possession and knowledge/biometric.

## Flows

Sign-in (`apps/admin/src/app/mfa`, pending cookie as before):

1. Password or Google succeeds. `mfaRequirement` returns `verify` when the person has a passkey or TOTP, `enroll` (TOTP) for staff with neither.
2. `verify`: if the person has a passkey the page leads with "Sign in with a passkey" and offers the authenticator code underneath; with `ADMIN_REQUIRE_PASSKEY` and a passkey, the code form is not rendered and the server refuses codes.
3. Policy on and no passkey: after TOTP (or TOTP enrollment plus recovery codes) `afterSecondFactor()` flips the parked record to mode `passkey_enroll` (same TTL) and the page shows "Create a passkey". The session is released only once a passkey is registered.
4. Tokens never reach the browser before the factor passes (unchanged).

Settings (`/account/security`): list, rename, add, remove. Add and remove require step-up: an assertion from an existing passkey, or (when the person has none) an authenticator/recovery code. Under the policy codes are not accepted for step-up when a passkey exists, and the last passkey cannot be removed.

Recovery: a `super_admin` (privilege `staff.passkeys.reset`, held by no other role) clicks "Reset passkeys" on `/staff`. `audited()` writes the row; all of the person's passkeys are revoked (`revokedReason: reset`) and their sessions revoked. Under the policy they sign in with password + TOTP and must enroll a new passkey. A lost TOTP is still the existing manual `person_mfa` reset. Staff cannot reset themselves.

## Data

`person_passkeys` (identity schema): credential id (unique), public key, sign count, transports, AAGUID, device type, backed-up flag, nickname, createdAt, lastUsedAt, revokedAt/revokedReason. Revoked rows are kept as a trail and deleted on erasure; the DPDP export lists metadata without key material. Challenges: Redis `webauthn:{reg|auth}:<realm>:<personId>`, 120 s, consumed with GETDEL.

## Events and audit

Domain events (versioned in the catalogue): `PasskeyRegistered`, `PasskeyRevoked` (reason `user|reset|clone_suspected`), `PasskeyCloneSuspected`. Security log: `passkey.registered|verified|failed|revoked|clone_suspected`. AdminAuditLog (privilege `self`): `passkey.registered`, `passkey.renamed`, `passkey.revoked`, `passkey.clone_suspected`; owner resets use `staff.passkeys_reset`.

Clone detection: after the signature verifies, if either counter is non-zero and the new counter is not greater than the stored one, the credential is revoked in the same transaction as the events, and the sign-in fails. The signature is verified first (the library's own counter check is bypassed with counter 0) so an attacker without the key cannot trigger revocations. Authenticators that always send 0 (most synced passkeys) are accepted.

## Decisions

- Library: `@simplewebauthn/server` 14.0.3 and `@simplewebauthn/browser` 14.0.0 (newest stable, no rc/beta).
- Passkey as second factor, not a password replacement: keeps the existing password-breach and rate-limit controls, and the pending-cookie flow stays the single place sessions are released.
- Default off; `ADMIN_REQUIRE_PASSKEY` is the enforcement switch and implies enabled. Dev derives RP ID/origin from `ADMIN_APP_URL`; production must set them explicitly (start-up validation: https origin without path, RP ID equal to or a parent of the host, no IP/localhost).
- `attestationType: none`, `residentKey: preferred`, `userVerification: required`.
- Under the policy, recovery codes are also refused for passkey holders: otherwise a phished password plus a stolen recovery code would bypass the policy. The break-glass is the owner reset.
- Step-up prefers an existing passkey so a stolen session plus a phished TOTP cannot add an attacker's key under the policy.
- Max 10 active passkeys per person and realm.
- Registration during forced enrollment relies on the TOTP that was just verified for the pending sign-in (no extra step-up).
- The staff `/staff` reset button only shows when passkeys are enabled; the privilege is added to `PRIVILEGES` so `super_admin` receives it automatically.
- No cookie/consent registry change: no new cookie or storage key (challenges are server side; the pending cookie already exists).
- Labels are English defaults with a `labels` prop (admin is English only). Seller adoption should supply translations.

## Mobbin research

Adopted patterns (all web):

- Passkeys as a titled section on the security page with a short "why", per-item rows and an "Add passkey" action: Square sign-in and security https://mobbin.com/screens/4f19c5b4-1850-42a3-a4e5-9376b20d2357, Dropbox Dash security tab https://mobbin.com/screens/9af05ddf-0a46-4db6-b8c6-5cb28707ed30.
- Empty state with one primary "Add passkey" and a sentence about device or security key: Delphi https://mobbin.com/screens/8f716203-655e-4027-a1c0-1e17bb503314.
- Enrollment prompt with a single primary "Create passkey" action and benefit copy: Telegram https://mobbin.com/screens/c3a0c060-2463-4b5f-96cb-c9ba03e5746f, Shopify https://mobbin.com/screens/6b33a1d7-f744-4a37-8717-a16a0996cddf (we omit "skip" under the policy).
- Sign-in: a primary "use a passkey" button next to an alternative path with an "or" separator: lululemon https://mobbin.com/screens/4d85f741-ad35-4675-b9d7-8d5b1976b831.
- Not adopted: the enable/disable toggle card (Supabase https://mobbin.com/screens/a1467124-7080-4316-8a6f-af60ba162f39), because enablement is deployment policy via env.

## Testing

- `packages/identity/test/passkeys.db.test.ts` with a software authenticator (`test/support/software-authenticator.ts`, ES256, none attestation) through the real verification code: registration, origin/RP/challenge/UV failures, duplicates, caps, assertion, replay, tampering, counter regression and the compare-and-swap race, step-up, policy, reset, privacy export/erasure.
- `packages/next-kit/test/mfa-flow.test.ts`, `mfa-actions.test.ts`: pending-flow policy, upgrade to `passkey_enroll`, audit writes.
- `packages/security/test/passkeys.secrets.test.ts`: production RP/origin validation.
- `apps/admin/src/app/(console)/staff/actions.test.ts`, `packages/admin/test/admin.test.ts`: owner-only reset through `audited()`.
- Browser ceremony UI (`passkey-client.tsx`) is not covered by Playwright (needs a virtual authenticator; to be added by the lead's e2e run with CDP `WebAuthn.addVirtualAuthenticator`).
