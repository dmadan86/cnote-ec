import { beforeEach, describe, expect, it, vi } from "vitest";

// The default ports call the owning modules with their REAL signatures (typed); these tests pin the mapping.
const cat = vi.hoisted(() => ({
  createVoiceNote: vi.fn(), draftListingFromVoice: vi.fn(), transcribeVoiceNote: vi.fn(), draftListingFromPhotos: vi.fn(), submitListingVersion: vi.fn(),
}));
vi.mock("@cnote/catalogue", () => cat);
vi.mock("@cnote/identity", () => ({ findOrCreatePersonByVerifiedPhone: vi.fn(), createBusiness: vi.fn(), setConsent: vi.fn() }));

const { defaultPorts } = await import("../src/ports");
const listing = { id: "L1", title: "Kraft box", category: { name: "Packaging" }, pricePaise: 520, priceUnit: "piece", moq: 500, moqUnit: "pcs" };
const jpg = { bytes: new Uint8Array([1]), mime: "image/jpeg" };
const ogg = { bytes: new Uint8Array([2]), mime: "audio/ogg" };

beforeEach(() => {
  for (const f of Object.values(cat)) f.mockReset();
  cat.createVoiceNote.mockResolvedValue({ id: "V1" });
  cat.draftListingFromPhotos.mockResolvedValue({ listing });
  cat.draftListingFromVoice.mockResolvedValue({ listing });
  cat.transcribeVoiceNote.mockResolvedValue({ transcript: "500 kraft boxes 3 ply" });
});

describe("draftFromMedia", () => {
  it("photos only: drafts from photos with the person and named files", async () => {
    const d = await defaultPorts.draftFromMedia("B1", "P1", { images: [jpg, { bytes: new Uint8Array([3]), mime: "image/webp" }] }, "hi");
    expect(cat.draftListingFromPhotos).toHaveBeenCalledWith("B1", "P1", { files: [{ bytes: jpg.bytes, filename: "whatsapp-1.jpg" }, { bytes: expect.any(Uint8Array), filename: "whatsapp-2.webp" }], hintText: undefined, language: "hi" });
    expect(d).toEqual({ listingId: "L1", title: "Kraft box", categoryName: "Packaging", pricePaise: 520, priceUnit: "piece", moq: 500, moqUnit: "pcs" });
  });

  it("voice only: stores the note and drafts from it", async () => {
    await defaultPorts.draftFromMedia("B1", "P1", { images: [], audio: ogg }, "en");
    expect(cat.createVoiceNote).toHaveBeenCalledWith("B1", "P1", { bytes: ogg.bytes, mimeType: "audio/ogg" });
    expect(cat.draftListingFromVoice).toHaveBeenCalledWith("B1", "P1", "V1", "en");
    expect(cat.draftListingFromPhotos).not.toHaveBeenCalled();
  });

  it("photos + voice: the transcript becomes the photo draft's hint", async () => {
    await defaultPorts.draftFromMedia("B1", "P1", { images: [jpg], audio: ogg }, "en");
    expect(cat.transcribeVoiceNote).toHaveBeenCalledWith("V1", { language: "en" });
    expect(cat.draftListingFromPhotos.mock.calls[0]![2]).toMatchObject({ hintText: "500 kraft boxes 3 ply" });
    expect(cat.draftListingFromVoice).not.toHaveBeenCalled();
  });

  it("no media is an error", async () => {
    await expect(defaultPorts.draftFromMedia("B1", "P1", { images: [] }, "en")).rejects.toThrow("No media");
  });

  it("submitListing submits a version with a change note", async () => {
    await defaultPorts.submitListing("B1", "L1");
    expect(cat.submitListingVersion).toHaveBeenCalledWith("B1", "L1", { changeNote: "Created via WhatsApp" });
  });
});
