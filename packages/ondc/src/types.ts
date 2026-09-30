import "@cnote/core";

declare module "@cnote/core" {
  interface JobTopics {
    /** Process one stored inbound ONDC request and queue its signed callback. Idempotent. */
    "ondc.inbound": { messageId: string };
    /** Deliver one stored outbound callback (signed at send time). Idempotent once `sent`. */
    "ondc.callback": { messageId: string };
  }
}
