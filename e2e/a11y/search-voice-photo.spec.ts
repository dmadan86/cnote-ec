/**
 * Voice search and search by image on /search (docs/design/search-vernacular-image-voice.md): axe WCAG 2.2 AA with the consent
 * and photo panels open (en + hi), accessible names and 44px targets, keyboard operation, the polite live region, the camera
 * `capture` input, and a stubbed record -> transcribe -> query flow. The microphone and the two API routes are faked, so this
 * needs no hardware and no ASR / vision provider.
 */
import { expect, test, type Page } from "../support/fixtures";
import { expectNoBlockingViolations, settle } from "../support/a11y";

const COPY = {
  en: { tools: "Search by voice or photo", voice: "Search by voice", image: "Search by image", take: "Take a photo", gallery: "Choose from gallery", agree: "Agree and start", cancel: "Cancel" },
  hi: { tools: "आवाज़ या फ़ोटो से खोजें", voice: "आवाज़ से खोजें", image: "फ़ोटो से खोजें", take: "फ़ोटो खींचें", gallery: "गैलरी से चुनें", agree: "सहमत हैं, शुरू करें", cancel: "" },
} as const;

/** A recorder that "records" 1 KB and a microphone that always works: enough to drive the UI deterministically. */
async function fakeMicrophone(page: Page) {
  await page.addInitScript(() => {
    class FakeRecorder extends EventTarget {
      static isTypeSupported = () => true;
      state = "inactive";
      mimeType = "audio/webm";
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor(public stream: unknown) {
        super();
      }
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob([new Uint8Array(1024)], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    (window as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeRecorder;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
    });
  });
}

for (const locale of ["en", "hi"] as const) {
  const t = COPY[locale];
  const prefix = locale === "hi" ? "/hi" : "";

  test.describe(`search by voice and image ${locale}`, () => {
    test("controls are named buttons with 44px targets and the group is labelled", async ({ page }) => {
      await fakeMicrophone(page);
      await page.goto(`${prefix}/search?q=box`);
      await settle(page);
      await expect(page.getByRole("group", { name: t.tools })).toBeVisible();
      for (const name of [t.voice, t.image]) {
        const button = page.getByRole("button", { name });
        await expect(button).toBeVisible();
        const box = (await button.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
      await expect(page.getByRole("button", { name: t.voice })).toHaveAttribute("aria-pressed", "false");
    });

    test("the voice consent notice has no blocking axe violations and Agree starts listening with the state announced", async ({ page }, info) => {
      await fakeMicrophone(page);
      await page.goto(`${prefix}/search?q=box`);
      await settle(page);
      await page.getByRole("button", { name: t.voice }).click();
      await expect(page.getByRole("button", { name: t.agree })).toBeVisible();
      await expectNoBlockingViolations(page, info);
      await page.getByRole("button", { name: t.agree }).click();
      // listening is conveyed by text in the polite live region AND by the pressed state, never by colour alone
      await expect(page.getByRole("button", { name: t.voice })).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("status")).not.toBeEmpty();
      await expectNoBlockingViolations(page, info);
    });

    test("the photo panel has no blocking axe violations, offers camera and gallery, and opens from the keyboard", async ({ page }, info) => {
      await page.goto(`${prefix}/search?q=box`);
      await settle(page);
      const open = page.getByRole("button", { name: t.image });
      await open.focus();
      await page.keyboard.press("Enter");
      await expect(open).toHaveAttribute("aria-expanded", "true");
      const panel = page.locator("#search-photo-panel");
      await expect(panel).toBeVisible();
      await expectNoBlockingViolations(page, info);
      // two real file inputs, both reachable by keyboard; only the camera one asks for the rear camera
      const camera = panel.locator("input[type=file][capture=environment]");
      await expect(camera).toHaveCount(1);
      await expect(camera).toHaveAttribute("accept", "image/*");
      await expect(panel.locator("input[type=file]:not([capture])")).toHaveCount(1);
      for (const label of [t.take, t.gallery]) expect((await panel.getByText(label).first().boundingBox())!.height).toBeGreaterThanOrEqual(44);
    });
  });
}

test("recording then stopping fills the search box and announces what was heard (stubbed ASR)", async ({ page }) => {
  await fakeMicrophone(page);
  await page.route("**/api/search/voice", (route) => route.fulfill({ json: { text: "cotton fabric", language: "en", confidence: 0.9 } }));
  await page.goto("/search?q=box");
  await settle(page);
  await page.getByRole("button", { name: COPY.en.voice }).click();
  await page.getByRole("button", { name: COPY.en.agree }).click();
  await expect(page.getByRole("button", { name: COPY.en.voice })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: COPY.en.voice }).click(); // tap again = stop
  await expect(page.locator("#search-q")).toHaveValue("cotton fabric");
  await expect(page.getByRole("status")).toContainText("cotton fabric");
  // the choice is remembered: the second recording starts without the notice
  await page.getByRole("button", { name: COPY.en.voice }).click();
  await expect(page.getByRole("button", { name: COPY.en.agree })).toHaveCount(0);
});

test("a denied microphone explains itself in text and leaves typing available", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { MediaRecorder: unknown }).MediaRecorder = class {
      static isTypeSupported = () => true;
    };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => Promise.reject(new DOMException("denied", "NotAllowedError")) } });
    localStorage.setItem("cnote_voice_consent_v1", "1");
  });
  await page.goto("/search?q=box");
  await settle(page);
  await page.getByRole("button", { name: COPY.en.voice }).click();
  await expect(page.getByRole("status")).toContainText(/Microphone access is blocked/);
  await expect(page.locator("#search-q")).toBeEditable();
});

test("choosing a photo searches for the words found in it (stubbed vision)", async ({ page }) => {
  await page.route("**/api/search/image", (route) => route.fulfill({ json: { query: "cotton fabric", keywords: ["cotton", "fabric"], category: null, confidence: 0.9 } }));
  await page.goto("/search?q=box");
  await settle(page);
  await page.getByRole("button", { name: COPY.en.image }).click();
  const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");
  await page.locator("#search-photo-panel input[type=file]:not([capture])").setInputFiles({ name: "p.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect(page).toHaveURL(/[?&]q=cotton\+fabric/);
  await expect(page).toHaveURL(/via=photo/);
});
