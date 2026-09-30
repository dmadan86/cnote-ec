// Payload shapes from Meta's Cloud API webhook docs (messages: text, image, audio, interactive; statuses).
export const wrap = (value: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA_ID", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "15550001111", phone_number_id: "PNID" }, ...value } }] }],
});
const contacts = (wa: string) => [{ profile: { name: "Ravi" }, wa_id: wa }];
export const textMsg = (wa: string, id: string, body: string, ts = "1700000000") =>
  wrap({ contacts: contacts(wa), messages: [{ from: wa, id, timestamp: ts, type: "text", text: { body } }] });
export const imageMsg = (wa: string, id: string, mediaId = "MEDIA1") =>
  wrap({ contacts: contacts(wa), messages: [{ from: wa, id, timestamp: "1700000001", type: "image", image: { id: mediaId, mime_type: "image/jpeg", sha256: "x", caption: "pipe" } }] });
export const audioMsg = (wa: string, id: string, mediaId = "MEDIA2") =>
  wrap({ contacts: contacts(wa), messages: [{ from: wa, id, timestamp: "1700000002", type: "audio", audio: { id: mediaId, mime_type: "audio/ogg; codecs=opus", voice: true } }] });
export const buttonMsg = (wa: string, id: string, bid: string, title = "x") =>
  wrap({ contacts: contacts(wa), messages: [{ from: wa, id, timestamp: "1700000003", type: "interactive", interactive: { type: "button_reply", button_reply: { id: bid, title } } }] });
export const listMsg = (wa: string, id: string, rid: string) =>
  wrap({ contacts: contacts(wa), messages: [{ from: wa, id, timestamp: "1700000004", type: "interactive", interactive: { type: "list_reply", list_reply: { id: rid, title: "t", description: "d" } } }] });
export const stickerMsg = (wa: string, id: string) =>
  wrap({ contacts: contacts(wa), messages: [{ from: wa, id, timestamp: "1700000005", type: "sticker", sticker: { id: "S" } }] });
export const statusMsg = (id: string, status: string, errors?: unknown[]) =>
  wrap({ statuses: [{ id, status, timestamp: "1700000006", recipient_id: "919876500001", ...(errors ? { errors } : {}) }] });
