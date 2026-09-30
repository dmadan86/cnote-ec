// MFA form strings (pure data, no React): the English defaults every app's translated `mfa` catalogue must mirror.
/** Every user-visible string of the MFA forms. Apps pass a translated (partial) set through `labels`; defaults are English. */
export interface MfaLabels {
  title: string;
  codeLabel: string;
  challengeHint: string;
  verify: string;
  verifying: string;
  cancelSignIn: string;
  onTitle: string;
  enrolledBody: string;
  continue: string;
  savedContinue: string;
  setupTitle: string;
  enrollNotice: string;
  /** Contains `{key}`, replaced by the bold `setupKeyName`. */
  setupKeyIntro: string;
  setupKeyName: string;
  setupKeyAria: string;
  /** Contains `{link}`, replaced by the `setupLinkText` link. */
  setupLinkIntro: string;
  setupLinkText: string;
  recoveryWarning: string;
  recoveryAria: string;
  sixDigit: string;
  currentCodeHint: string;
  turnOn: string;
  checking: string;
  cancel: string;
  settingsIntro: string;
  requiredForRole: string;
  recommended: string;
  setUp: string;
  preparing: string;
  /** Contains `{count}`. */
  onNotice: string;
  confirmCode: string;
  regenHint: string;
  regenerate: string;
  working: string;
  cannotDisable: string;
  turnOffCode: string;
  turnOff: string;
}

export const DEFAULT_MFA_LABELS: MfaLabels = {
  title: "Two-factor authentication",
  codeLabel: "Authentication code",
  challengeHint: "Enter the 6-digit code from your authenticator app, or a recovery code.",
  verify: "Verify",
  verifying: "Verifying…",
  cancelSignIn: "Cancel and sign in again",
  onTitle: "Two-factor authentication is on",
  enrolledBody: "Your authenticator is set up. You can create new recovery codes later under Account, then Security.",
  continue: "Continue",
  savedContinue: "I've saved them. Continue",
  setupTitle: "Set up two-factor authentication",
  enrollNotice: "Back-office access requires a second factor. Set it up once; you'll be asked for a code at every sign-in.",
  setupKeyIntro: "In your authenticator app (Google Authenticator, 1Password, Authy…) choose {key} and type:",
  setupKeyName: "Enter a setup key",
  setupKeyAria: "Setup key",
  setupLinkIntro: "On a phone with an authenticator installed you can also {link}.",
  setupLinkText: "open the setup link",
  recoveryWarning: "Save these recovery codes somewhere safe. Each works once if you lose your authenticator. They won't be shown again.",
  recoveryAria: "Recovery codes",
  sixDigit: "6-digit code",
  currentCodeHint: "Enter the current code shown in the app.",
  turnOn: "Turn on two-factor",
  checking: "Checking…",
  cancel: "Cancel",
  settingsIntro: "Add a second step to sign-in using an authenticator app.",
  requiredForRole: "It is required for your role.",
  recommended: "Recommended for anyone who can spend credits or edit listings.",
  setUp: "Set up two-factor",
  preparing: "Preparing…",
  onNotice: "Two-factor authentication is on. Recovery codes left: {count}.",
  confirmCode: "Code to confirm",
  regenHint: "A current code is needed to make new recovery codes (the old ones stop working).",
  regenerate: "Generate new recovery codes",
  working: "Working…",
  cannotDisable: "Two-factor cannot be turned off for back-office accounts.",
  turnOffCode: "Code to turn off",
  turnOff: "Turn off two-factor",
};
