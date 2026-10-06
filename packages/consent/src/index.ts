// @cnote/consent: the framework-free consent core shared by every app (buyer web, seller, studio, admin): the consent record
// (state), the storage registry types and helpers, the browser-side manager logic (./client), policy snapshots (./policy, node only)
// and the source scanners for the per-app registry tests (./testing, node only). No react / next / database imports (ADR-006).
// The React UI (banner, dialog) lives in @cnote/next-kit/consent; receipts are written by @cnote/compliance.
export * from "./state";
export * from "./registry";
export * from "./account-sync";
