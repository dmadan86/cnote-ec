import { defineTemplates } from "@cnote/templates";

// Templates owned by the email/auth flows. Other modules register their own keys with defineTemplates().
defineTemplates([
  {
    key: "auth.password_reset",
    name: "Password reset",
    description: "Sent when someone asks to reset their password. Contains the single-use reset link.",
    category: "security",
    channels: ["email"],
    variables: [
      { name: "name", description: "Recipient's name (may be empty)", example: "Asha" },
      { name: "resetUrl", description: "Single-use password reset link", example: "https://app.example.com/reset-password?token=abc123", required: true },
      { name: "expiresInMinutes", description: "How long the link stays valid", example: "30" },
    ],
    defaults: {
      email: {
        subject: "Reset your password",
        preheader: "Use this link within {{expiresInMinutes}} minutes to choose a new password.",
        body:
          "<h2>Reset your password</h2>{{#name}}<p>Hi {{name}},</p>{{/name}}<p>We received a request to reset your password. Use the link below within {{expiresInMinutes}} minutes.</p>" +
          '<p><a href="{{resetUrl}}">Choose a new password</a></p><p>If you did not ask for this, you can safely ignore this email: your password will not change.</p>',
      },
    },
  },
  {
    key: "auth.welcome",
    name: "Welcome",
    description: "Sent after a new account is created.",
    category: "transactional",
    channels: ["email"],
    variables: [
      { name: "name", description: "Recipient's name", example: "Asha" },
      { name: "appUrl", description: "Link to the marketplace", example: "https://app.example.com" },
    ],
    defaults: {
      email: {
        subject: "Welcome to BizKart",
        preheader: "Your account is ready.",
        body: '<h2>Welcome, {{name}}!</h2><p>Your account is ready. Find verified suppliers, post what you need and compare quotes in one place.</p><p><a href="{{appUrl}}">Open the marketplace</a></p>',
      },
    },
  },
  {
    key: "auth.new_sign_in",
    name: "New sign-in alert",
    description: "Security notice when an account signs in from a new device or place.",
    category: "security",
    channels: ["email"],
    variables: [
      { name: "name", description: "Recipient's name (may be empty)", example: "Asha" },
      { name: "device", description: "Browser / device summary", example: "Chrome on Windows" },
      { name: "ip", description: "IP address of the sign-in", example: "203.0.113.7" },
      { name: "time", description: "When it happened (formatted)", example: "29 Sep 2026, 3:42 pm IST" },
      { name: "securityUrl", description: "Link to review account security", example: "https://app.example.com/account/security" },
    ],
    defaults: {
      email: {
        subject: "New sign-in to your account",
        preheader: "We noticed a sign-in from {{device}}.",
        body:
          "<h2>New sign-in</h2>{{#name}}<p>Hi {{name}},</p>{{/name}}<p>We noticed a new sign-in to your account.</p>" +
          "<ul><li><strong>Device:</strong> {{device}}</li><li><strong>IP address:</strong> {{ip}}</li><li><strong>Time:</strong> {{time}}</li></ul>" +
          '<p>If this was you, no action is needed. If not, <a href="{{securityUrl}}">secure your account</a> now.</p>',
      },
    },
  },
  {
    key: "system.test",
    name: "System test",
    description: "Generic message used to check that email delivery works.",
    category: "transactional",
    channels: ["email"],
    variables: [{ name: "message", description: "Any text", example: "This is a test message." }],
    defaults: {
      email: { subject: "Test email", preheader: "Delivery check", body: "<h2>Test email</h2><p>{{message}}</p>" },
    },
  },
  {
    key: "system.message",
    name: "System message",
    description: "Plain message with a custom subject. Used for legacy/one-off messages that have no dedicated template.",
    category: "transactional",
    channels: ["email"],
    variables: [
      { name: "subject", description: "Email subject", example: "A message from BizKart", required: true },
      { name: "message", description: "Message text", example: "Hello from BizKart.", required: true },
    ],
    defaults: { email: { subject: "{{subject}}", body: "<p>{{message}}</p>" } },
  },
]);
