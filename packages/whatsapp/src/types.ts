// Shared types for the WhatsApp channel (ADR-004). Meta Cloud API payload shapes live in parse.ts.

export type InboundContent =
  | { type: "text"; text: string }
  | { type: "button"; id: string; title: string }
  | { type: "image"; mediaId: string; mime: string; caption?: string }
  | { type: "audio"; mediaId: string; mime: string; voice: boolean }
  | { type: "unsupported"; original: string };

export interface InboundMessage {
  /** wamid: the idempotency key */
  id: string;
  /** sender wa_id (digits, no "+") */
  from: string;
  profileName?: string;
  /** Meta timestamp, ISO */
  timestamp: string;
  content: InboundContent;
}

export type StatusValue = "sent" | "delivered" | "read" | "failed";
export interface StatusUpdate {
  /** wamid of OUR outbound message */
  id: string;
  status: StatusValue;
  recipient: string;
  timestamp: string;
  error?: { code: number; title: string };
}

export type InboundJob =
  | { kind: "message"; message: InboundMessage }
  | { kind: "status"; status: StatusUpdate };

declare module "@cnote/core" {
  interface JobTopics {
    "whatsapp.inbound": InboundJob;
  }
}

export interface MediaBytes {
  bytes: Uint8Array;
  mime: string;
}

export interface ReplyButton {
  id: string;
  /** max 20 chars (Meta) */
  title: string;
}
export interface ListRow {
  id: string;
  /** max 24 chars (Meta) */
  title: string;
  description?: string;
}
export interface InteractiveMessage {
  /** max 1024 chars */
  body: string;
  /** up to 3 reply buttons */
  buttons?: ReplyButton[];
  /** list message (up to 10 rows) */
  list?: { button: string; rows: ListRow[] };
}
export interface TemplateMessage {
  /** Meta-approved template name */
  name: string;
  language: string;
  /** body variables in order ({{1}}, {{2}} ...) */
  bodyParams?: string[];
}
export interface SendResult {
  providerId: string;
}
