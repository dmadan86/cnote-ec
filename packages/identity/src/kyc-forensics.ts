// Classical (non-AI) image forensics for KYC documents (ADR-003 T2). Pure functions, unit-tested.
// These are cheap signals, not proof: each one feeds a "review" verdict, never a silent pass.

/** Editing / design tools whose name in EXIF Software, XMP CreatorTool or a PNG text chunk suggests the file was edited or synthesised. */
const EDITORS: [RegExp, string][] = [
  [/adobe photoshop|photoshop:|photoshop /i, "Adobe Photoshop"], [/adobe illustrator|illustrator/i, "Adobe Illustrator"], [/lightroom/i, "Lightroom"],
  [/gimp/i, "GIMP"], [/canva/i, "Canva"], [/picsart/i, "PicsArt"], [/snapseed/i, "Snapseed"], [/pixlr/i, "Pixlr"], [/photopea/i, "Photopea"],
  [/paint\.net/i, "Paint.NET"], [/affinity (photo|designer)/i, "Affinity"], [/coreldraw|corel photo/i, "CorelDRAW"], [/fotor/i, "Fotor"],
  [/stable diffusion|midjourney|dall[-·. ]?e|firefly|comfyui/i, "AI image generator"],
];

const SCAN_HEAD = 256 * 1024;
const latin1 = (b: Uint8Array, from: number, to: number) => Buffer.from(b.buffer, b.byteOffset + from, Math.max(0, Math.min(b.length, to) - from)).toString("latin1");

/** Names of editing software found in the file's metadata blocks (head + tail scan; metadata is not compressed in JPEG/WebP; PNG tEXt is plain). */
export function editingSoftware(bytes: Uint8Array): string[] {
  const text = latin1(bytes, 0, SCAN_HEAD) + "\n" + (bytes.length > SCAN_HEAD ? latin1(bytes, bytes.length - 64 * 1024, bytes.length) : "");
  return [...new Set(EDITORS.filter(([re]) => re.test(text)).map(([, name]) => name))];
}

/** Typical desktop / phone screenshot sizes: a document "photo" with exactly these dimensions is usually a screenshot of a screen. */
const SCREEN_SIZES = new Set(["1920x1080", "1366x768", "1536x864", "1280x720", "2560x1440", "1440x900", "1080x1920", "1080x2340", "1080x2400", "1170x2532", "1284x2778", "1179x2556"]);

export interface ImageChecks {
  metadataAnomalies: string[];
  lowResolution: boolean;
  likelyScreenshot: boolean;
  aspectImplausible: boolean;
}

export function imageChecks(bytes: Uint8Array, mimeType: string, width: number, height: number): ImageChecks {
  const anomalies: string[] = [];
  for (const s of editingSoftware(bytes)) anomalies.push(`Metadata names editing software: ${s}`);
  const long = Math.max(width, height), short = Math.min(width, height);
  const lowResolution = long < 800 || short < 500;
  const likelyScreenshot = mimeType === "image/png" && SCREEN_SIZES.has(`${width}x${height}`);
  const aspectImplausible = short === 0 || long / short > 3.2;
  return { metadataAnomalies: anomalies, lowResolution, likelyScreenshot, aspectImplausible };
}
