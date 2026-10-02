// Prompt-injection hardening (ADR-008): every provider wraps untrusted text in a <user_input> envelope.
// JSON.stringify does not escape `<`, `>` or `&`, so user text containing "</user_input>" could close the
// envelope and pose as instructions. Escaping them as JSON unicode escapes keeps the payload valid JSON
// (the model still reads the characters) while making the envelope impossible to break out of.

export function escapeForEnvelope(json: string): string {
  return json.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

export function userInputEnvelope(payload: unknown): string {
  return `<user_input>\n${escapeForEnvelope(JSON.stringify(payload))}\n</user_input>`;
}
