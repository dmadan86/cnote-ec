// Ports to the other modules, so the conversation logic is testable without them. Defaults call the public
// functions of @cnote/identity and @cnote/catalogue. Where a function is not exported yet the port fails loudly.
import * as catalogue from "@cnote/catalogue";
import * as identity from "@cnote/identity";
import type { Lang } from "./copy";
import type { MediaBytes } from "./types";

export interface DraftedListing {
  listingId: string;
  title: string;
  categoryName: string;
  pricePaise: number | null;
  priceUnit: string | null;
  moq: number | null;
  moqUnit: string | null;
}

export interface WhatsAppPorts {
  /** Person for a Meta-verified WhatsApp number (created, phone verified, if new). */
  findOrCreatePerson(phoneE164: string): Promise<{ personId: string }>;
  createSellerBusiness(personId: string, input: { name: string; city?: string; pincode?: string; language: Lang }): Promise<{ businessId: string }>;
  recordConsent(personId: string, purpose: "matching" | "marketing", granted: boolean, source: string): Promise<void>;
  /** Photos and/or a voice note -> an AI-drafted listing. A voice note sent with photos becomes the photo draft's hint. */
  draftFromMedia(businessId: string, personId: string, media: { images: MediaBytes[]; audio?: MediaBytes }, language: Lang): Promise<DraftedListing>;
  submitListing(businessId: string, listingId: string): Promise<void>;
}

const toDrafted = (l: catalogue.ListingView): DraftedListing => ({
  listingId: l.id, title: l.title, categoryName: l.category?.name ?? "-", pricePaise: l.pricePaise ?? null, priceUnit: l.priceUnit ?? null, moq: l.moq ?? null, moqUnit: l.moqUnit ?? null,
});

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

// Typed calls into the owning modules: a signature change there is a compile error here, not a runtime failure.
export const defaultPorts: WhatsAppPorts = {
  async findOrCreatePerson(phone) {
    return identity.findOrCreatePersonByVerifiedPhone(phone);
  },
  async createSellerBusiness(personId, i) {
    return identity.createBusiness(personId, { name: i.name, city: i.city, pincode: i.pincode, isSeller: true, languages: [i.language] });
  },
  async recordConsent(personId, purpose, granted, source) {
    await identity.setConsent(personId, purpose, granted, source);
  },
  async draftFromMedia(businessId, personId, media, language) {
    // Voice notes are transcribed and the audio discarded unless voice_retention consent exists (never asked here).
    let hint: string | undefined;
    if (media.audio) {
      const note = await catalogue.createVoiceNote(businessId, personId, { bytes: media.audio.bytes, mimeType: media.audio.mime });
      if (!media.images.length) return toDrafted((await catalogue.draftListingFromVoice(businessId, personId, note.id, language)).listing);
      hint = (await catalogue.transcribeVoiceNote(note.id, { language })).transcript ?? undefined;
    }
    if (!media.images.length) throw new Error("No media to draft from");
    const files = media.images.map((m, i) => ({ bytes: m.bytes, filename: `whatsapp-${i + 1}.${EXT[m.mime] ?? "jpg"}` }));
    return toDrafted((await catalogue.draftListingFromPhotos(businessId, personId, { files, hintText: hint, language })).listing);
  },
  async submitListing(businessId, listingId) {
    await catalogue.submitListingVersion(businessId, listingId, { changeNote: "Created via WhatsApp" });
  },
};

let ports: WhatsAppPorts = defaultPorts;
export const getPorts = () => ports;
export const setWhatsAppPorts = (p: Partial<WhatsAppPorts> | undefined) => void (ports = p ? { ...defaultPorts, ...p } : defaultPorts);
