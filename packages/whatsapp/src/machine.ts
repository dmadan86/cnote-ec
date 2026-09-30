// Seller onboarding conversation: a PURE transition function (state, input, now) -> (state, effects). No I/O here;
// conversation.ts executes effects and feeds results back through the apply* functions. ADR-004, consent per ADR-010.
import { isLang, type Lang } from "./copy";
import { normText } from "./keywords";

export type Step = "language" | "consent" | "business_name" | "location" | "media" | "collecting" | "processing" | "review" | "done" | "declined";
export const STEPS: Step[] = ["language", "consent", "business_name", "location", "media", "collecting", "processing", "review", "done", "declined"];
/** Steps that may only be reached after the seller consented. */
export const POST_CONSENT: ReadonlySet<Step> = new Set(["business_name", "location", "media", "collecting", "processing", "review", "done"]);

export interface MediaRef {
  id: string;
  kind: "image" | "audio";
  mime: string;
}
export interface FlowData {
  lang: Lang;
  consent?: boolean;
  consentAt?: string;
  businessName?: string;
  city?: string | null;
  pincode?: string;
  personId?: string;
  businessId?: string;
  media?: MediaRef[];
  listingId?: string;
  draft?: { title: string; category: string; price: string; moq: string };
  /** ISO time of the last inbound message: drives the "welcome back" resume prefix and stuck-processing recovery */
  lastAt?: string;
}
export interface FlowState {
  flow: "seller_onboarding";
  step: Step;
  data: FlowData;
}

export type Input =
  | { type: "text"; text: string }
  | { type: "button"; id: string }
  | { type: "media"; kind: "image" | "audio"; mediaId: string; mime: string }
  | { type: "other" };

export type ButtonId = string;
export type Effect =
  | { t: "reply"; key: string; buttons?: ButtonId[]; list?: "languages" }
  | { t: "setLanguage"; lang: Lang }
  | { t: "provision" }
  | { t: "draft" }
  | { t: "submit" };

export interface Transition {
  state: FlowState;
  effects: Effect[];
}

export const MAX_IMAGES = 5;
export const MAX_AUDIO = 1;
export const RESUME_AFTER_MS = 6 * 3_600_000;
export const STUCK_PROCESSING_MS = 10 * 60_000;

export const initialState = (lang: Lang = "en"): FlowState => ({ flow: "seller_onboarding", step: "language", data: { lang } });

const reply = (key: string, extra: Partial<Extract<Effect, { t: "reply" }>> = {}): Effect => ({ t: "reply", key, ...extra });
const YES = new Set(["yes", "y", "ok", "okay", "agree", "i agree", "haan", "han", "ha", "हाँ", "हां", "हा", "सहमत", "ठीक है", "theek hai", "1"]);
const NO = new Set(["no", "n", "nahi", "nahin", "नहीं", "नही", "no thanks", "2"]);
const DONE = new Set(["done", "ok", "finish", "that is all", "हो गया", "ho gaya", "bas", "बस"]);
const SUBMIT = new Set(["submit", "looks good", "yes", "ok", "okay", "haan", "हाँ", "हां", "ठीक है", "जमा करें", "ठीक है, जमा करें"]);
const EDIT = new Set(["edit", "change", "बदलें", "वेब पर बदलें", "edit on web"]);
const RESTART = new Set(["restart", "reset", "start over", "फिर से शुरू", "दोबारा शुरू", "phir se shuru"]);
const HELP = new Set(["help", "?", "मदद", "सहायता", "madad", "sahayata"]);
const LANG_TEXT: Record<string, Lang> = { english: "en", eng: "en", hindi: "hi", हिंदी: "hi", हिन्दी: "hi", kannada: "kn", tamil: "ta", telugu: "te", marathi: "mr", gujarati: "gu", bengali: "bn" };

const PINCODE = /(?<![0-9])[1-9][0-9]{5}(?![0-9])/;

/** "Ludhiana 141003" -> { city: "Ludhiana", pincode: "141003" }; null when no pincode is present. */
export function parseLocation(text: string): { city: string | null; pincode: string } | null {
  const m = PINCODE.exec(text);
  if (!m) return null;
  const city = text.replace(m[0], " ").replace(/[^\p{L}\p{M}\s.-]/gu, " ").replace(/\s+/g, " ").replace(/^[\s.-]+|[\s.-]+$/g, "").slice(0, 60);
  return { city: city.length >= 2 ? city : null, pincode: m[0] };
}

const promptFor = (s: FlowState): Effect[] => {
  switch (s.step) {
    case "language": return [reply("greet", { buttons: ["lang_en", "lang_hi", "lang_more"] })];
    case "consent": return [reply("consent", { buttons: ["consent_yes", "consent_no"] })];
    case "business_name": return [reply("ask_business_name")];
    case "location": return [reply("ask_location")];
    case "media": return [reply("ask_media")];
    case "collecting": return [reply("got_media", { buttons: ["done"] })];
    case "processing": return [reply("processing_wait")];
    case "review": return [reply("draft_summary", { buttons: ["submit", "edit"] })];
    case "done": return [reply("done_again")];
    case "declined": return [reply("greet", { buttons: ["lang_en", "lang_hi", "lang_more"] })];
  }
};

const clone = (s: FlowState): FlowState => ({ ...s, data: { ...s.data } });
const withStep = (s: FlowState, step: Step): FlowState => ({ ...s, step });
const isCmd = (t: string, set: Set<string>) => set.has(normText(t));
const btn = (i: Input) => (i.type === "button" ? i.id : null);
const textOf = (i: Input) => (i.type === "text" ? i.text.trim() : "");

function addMedia(data: FlowData, i: Extract<Input, { type: "media" }>): boolean {
  const media = [...(data.media ?? [])];
  const same = media.filter((m) => m.kind === i.kind).length;
  if (same >= (i.kind === "image" ? MAX_IMAGES : MAX_AUDIO) || media.some((m) => m.id === i.mediaId)) return false;
  media.push({ id: i.mediaId, kind: i.kind, mime: i.mime });
  data.media = media;
  return true;
}

export function transition(prev: FlowState, input: Input, now: Date): Transition {
  let s = clone(prev);
  const effects: Effect[] = [];
  const nowIso = now.toISOString();
  const idle = prev.data.lastAt ? now.getTime() - Date.parse(prev.data.lastAt) : 0;
  s.data.lastAt = nowIso;

  // Stuck "processing" (worker died mid-draft): let the seller continue.
  if (s.step === "processing" && idle > STUCK_PROCESSING_MS) s = withStep(s, "collecting");

  // A seller who returns after a long pause gets a short welcome-back before the current prompt.
  const resumed = idle > RESUME_AFTER_MS && !["language", "done", "declined"].includes(s.step);

  // ----- global commands (never skip consent: restart only keeps an existing consent)
  const text = textOf(input);
  if (input.type === "text" && isCmd(text, HELP)) return { state: s, effects: [reply("help"), ...promptFor(s)] };
  if (input.type === "text" && isCmd(text, RESTART)) {
    const keepConsent = s.data.consent === true;
    const data: FlowData = { lang: s.data.lang, lastAt: nowIso, personId: s.data.personId, businessId: s.data.businessId, businessName: s.data.businessName, city: s.data.city, pincode: s.data.pincode };
    if (keepConsent) {
      data.consent = true;
      data.consentAt = s.data.consentAt;
    }
    const step: Step = !keepConsent ? "language" : data.businessId ? "media" : "business_name";
    s = { flow: "seller_onboarding", step, data };
    return { state: s, effects: [reply("restarted"), ...promptFor(s)] };
  }
  if (input.type === "other") return { state: s, effects: [reply("unsupported"), ...promptFor(s)] };

  const out = (state: FlowState, ...e: Effect[]): Transition => ({ state, effects: [...(resumed ? [reply("resume")] : []), ...e] });

  switch (s.step) {
    case "declined":
      return out(withStep(s, "language"), ...promptFor({ ...s, step: "language" }));

    case "language": {
      const id = btn(input);
      let lang: Lang | undefined;
      if (id?.startsWith("lang_") && id !== "lang_more" && isLang(id.slice(5))) lang = id.slice(5) as Lang;
      else if (input.type === "text") lang = LANG_TEXT[normText(text)];
      if (id === "lang_more") return out(s, reply("language_more", { list: "languages" }));
      if (!lang) return out(s, ...promptFor(s));
      s.data.lang = lang;
      s = withStep(s, "consent");
      return out(s, { t: "setLanguage", lang }, ...promptFor(s));
    }

    case "consent": {
      const id = btn(input);
      const yes = id === "consent_yes" || (input.type === "text" && YES.has(normText(text)));
      const no = id === "consent_no" || (input.type === "text" && NO.has(normText(text)));
      if (yes) {
        s.data.consent = true;
        s.data.consentAt = nowIso;
        s = withStep(s, "business_name");
        return out(s, ...promptFor(s));
      }
      if (no) return out({ flow: "seller_onboarding", step: "declined", data: { lang: s.data.lang, lastAt: nowIso } }, reply("consent_declined"));
      return out(s, ...promptFor(s));
    }

    case "business_name": {
      const name = text.replace(/\s+/g, " ");
      if (input.type !== "text" || name.length < 2 || name.length > 100 || /https?:\/\//i.test(name)) return out(s, reply("invalid_name"));
      s.data.businessName = name;
      s = withStep(s, "location");
      return out(s, ...promptFor(s));
    }

    case "location": {
      const loc = input.type === "text" ? parseLocation(text) : null;
      if (!loc) return out(s, reply("invalid_location"));
      s.data.city = loc.city;
      s.data.pincode = loc.pincode;
      // WhatsApp numbers are verified by Meta, so the number itself is treated as phone-verified (T0, ADR-003).
      return out(s, { t: "provision" });
    }

    case "media":
    case "collecting": {
      if (input.type === "media") {
        const first = s.step === "media";
        const added = addMedia(s.data, input);
        s = withStep(s, "collecting");
        return out(s, ...(first && added ? promptFor(s) : []));
      }
      const wantsDone = btn(input) === "done" || (input.type === "text" && isCmd(text, DONE));
      if (wantsDone && (s.data.media?.length ?? 0) > 0) {
        s = withStep(s, "processing");
        return out(s, reply("processing"), { t: "draft" });
      }
      return out(s, reply("nudge_media"), ...(s.step === "collecting" && (s.data.media?.length ?? 0) > 0 ? promptFor(s) : []));
    }

    case "processing":
      return out(s, reply("processing_wait"));

    case "review": {
      if (input.type === "media") {
        s.data.media = [];
        s.data.listingId = undefined;
        s.data.draft = undefined;
        addMedia(s.data, input);
        s = withStep(s, "collecting");
        return out(s, ...promptFor(s));
      }
      const id = btn(input);
      if (id === "edit" || (input.type === "text" && isCmd(text, EDIT))) return out(s, reply("edit_link"));
      if (id === "submit" || (input.type === "text" && isCmd(text, SUBMIT))) return out(s, { t: "submit" });
      return out(s, reply("review_prompt", { buttons: ["submit", "edit"] }));
    }

    case "done": {
      if (input.type === "media") {
        s.data.media = [];
        s.data.listingId = undefined;
        s.data.draft = undefined;
        addMedia(s.data, input);
        s = withStep(s, "collecting");
        return out(s, ...promptFor(s));
      }
      return out(s, ...promptFor(s));
    }
  }
}

// ----- results of executing effects
export function applyProvisioned(s: FlowState, r: { ok: true; personId: string; businessId: string } | { ok: false }): Transition {
  if (!r.ok) return { state: withStep({ ...s, data: { ...s.data } }, "location"), effects: [reply("provision_failed")] };
  const state = withStep({ ...s, data: { ...s.data, personId: r.personId, businessId: r.businessId } }, "media");
  return { state, effects: [reply("ask_media")] };
}

export function applyDrafted(s: FlowState, r: { ok: true; listingId: string; draft: NonNullable<FlowData["draft"]> } | { ok: false }): Transition {
  if (!r.ok) return { state: withStep({ ...s, data: { ...s.data, media: [] } }, "media"), effects: [reply("media_failed")] };
  const state = withStep({ ...s, data: { ...s.data, listingId: r.listingId, draft: r.draft, media: [] } }, "review");
  return { state, effects: [reply("draft_summary", { buttons: ["submit", "edit"] })] };
}

export function applySubmitted(s: FlowState, r: { ok: boolean }): Transition {
  if (!r.ok) return { state: { ...s, data: { ...s.data } }, effects: [reply("submit_failed")] };
  return { state: withStep({ ...s, data: { ...s.data } }, "done"), effects: [reply("submitted")] };
}

/** Legacy/corrupt JSON in WhatsAppContact.state -> a valid FlowState (never trust the column). */
export function coerceState(raw: unknown, lang: Lang = "en"): FlowState {
  const r = raw as Partial<FlowState> | null;
  if (!r || r.flow !== "seller_onboarding" || !STEPS.includes(r.step as Step) || typeof r.data !== "object" || !r.data) return initialState(lang);
  const st = r as FlowState;
  if (POST_CONSENT.has(st.step) && st.data.consent !== true) return initialState(isLang(st.data.lang) ? st.data.lang : lang);
  return { flow: "seller_onboarding", step: st.step, data: { ...st.data, lang: isLang(st.data.lang) ? st.data.lang : lang } };
}
