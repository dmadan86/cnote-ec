import { describe, expect, it } from "vitest";
import { applyDrafted, applyProvisioned, applySubmitted, coerceState, initialState, POST_CONSENT, RESUME_AFTER_MS, STEPS, STUCK_PROCESSING_MS, transition, type Effect, type FlowState, type Input } from "../src/machine";

const T0 = new Date("2026-01-01T10:00:00Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
const txt = (text: string): Input => ({ type: "text", text });
const btn = (id: string): Input => ({ type: "button", id });
const img = (id = "m1"): Input => ({ type: "media", kind: "image", mediaId: id, mime: "image/jpeg" });
const voice = (id = "a1"): Input => ({ type: "media", kind: "audio", mediaId: id, mime: "audio/ogg" });
const keys = (effects: Effect[]) => effects.filter((e) => e.t === "reply").map((e) => (e as { key: string }).key);

/** Drives the machine, simulating effect results like the executor does. */
function step(s: FlowState, i: Input, now = T0, results: { provision?: boolean; draft?: boolean; submit?: boolean } = {}) {
  const t = transition(s, i, now);
  let state = t.state;
  const seen: Effect[] = [...t.effects];
  const queue = [...t.effects];
  while (queue.length) {
    const e = queue.shift()!;
    if (e.t === "provision") {
      const r = applyProvisioned(state, results.provision === false ? { ok: false } : { ok: true, personId: "p1", businessId: "b1" });
      state = r.state; seen.push(...r.effects);
    } else if (e.t === "draft") {
      const r = applyDrafted(state, results.draft === false ? { ok: false } : { ok: true, listingId: "l1", draft: { title: "Pipe", category: "Steel", price: "Rs 5", moq: "-" } });
      state = r.state; seen.push(...r.effects);
    } else if (e.t === "submit") {
      const r = applySubmitted(state, { ok: results.submit !== false });
      state = r.state; seen.push(...r.effects);
    }
  }
  return { state, effects: seen };
}

const consented = (): FlowState => {
  let s = initialState();
  s = step(s, btn("lang_en")).state;
  return step(s, btn("consent_yes")).state;
};

describe("onboarding happy path", () => {
  it("walks greet to done", () => {
    let s = initialState();
    let r = step(s, txt("hi"));
    expect(r.state.step).toBe("language");
    expect(keys(r.effects)).toEqual(["greet"]);
    r = step(r.state, btn("lang_hi"));
    expect(r.state.data.lang).toBe("hi");
    expect(r.state.step).toBe("consent");
    expect(r.effects.find((e) => e.t === "reply")).toMatchObject({ key: "consent", buttons: ["consent_yes", "consent_no"] });
    r = step(r.state, btn("consent_yes"));
    expect(r.state).toMatchObject({ step: "business_name", data: { consent: true } });
    r = step(r.state, txt("Sharma Steel"));
    expect(r.state.step).toBe("location");
    r = step(r.state, txt("Ludhiana 141003"));
    expect(r.state).toMatchObject({ step: "media", data: { businessId: "b1", city: "Ludhiana", pincode: "141003" } });
    r = step(r.state, img());
    expect(r.state.step).toBe("collecting");
    expect(keys(r.effects)).toEqual(["got_media"]);
    r = step(r.state, voice());
    expect(r.effects).toEqual([]);
    r = step(r.state, btn("done"));
    expect(r.state).toMatchObject({ step: "review", data: { listingId: "l1" } });
    expect(keys(r.effects)).toEqual(["processing", "draft_summary"]);
    r = step(r.state, btn("edit"));
    expect(keys(r.effects)).toEqual(["edit_link"]);
    expect(r.state.step).toBe("review");
    r = step(r.state, btn("submit"));
    expect(r.state.step).toBe("done");
    expect(keys(r.effects)).toContain("submitted");
    r = step(r.state, img("m9"));
    expect(r.state.step).toBe("collecting");
    expect(r.state.data.listingId).toBeUndefined();
  });
});

describe("step behaviour", () => {
  it("language: text names, more list, unknown re-prompts", () => {
    expect(step(initialState(), txt("Hindi")).state.data.lang).toBe("hi");
    expect(step(initialState(), btn("lang_more")).effects[0]).toMatchObject({ key: "language_more", list: "languages" });
    expect(step(initialState(), btn("lang_ta")).state.data.lang).toBe("ta");
    expect(step(initialState(), txt("???")).state.step).toBe("language");
    expect(step(initialState(), btn("lang_zz")).state.step).toBe("language");
  });
  it("consent: yes words, no words, unclear; declined restarts on any input", () => {
    let s = step(initialState(), btn("lang_en")).state;
    expect(step(s, txt("haan")).state.data.consent).toBe(true);
    expect(step(s, txt("banana")).state.step).toBe("consent");
    const d = step(s, btn("consent_no")).state;
    expect(d.step).toBe("declined");
    expect(d.data.consent).toBeUndefined();
    expect(step(s, txt("no")).state.step).toBe("declined");
    expect(step(d, txt("hi")).state.step).toBe("language");
  });
  it("business name validation", () => {
    const s = consented();
    for (const bad of [txt("a"), txt("x".repeat(101)), txt("http://spam.example"), btn("done"), img()]) expect(step(s, bad).state.step).toBe("business_name");
  });
  it("location requires a pincode; provisioning failure returns to location", () => {
    let s = step(consented(), txt("Acme")).state;
    expect(step(s, txt("Delhi")).state.step).toBe("location");
    expect(keys(step(s, txt("Delhi")).effects)).toEqual(["invalid_location"]);
    const r = step(s, txt("Delhi 110001"), T0, { provision: false });
    expect(r.state.step).toBe("location");
    expect(keys(r.effects)).toContain("provision_failed");
  });
  it("collecting: caps images, dedupes ids, done without media nudges, text nudges", () => {
    let s = step(step(step(consented(), txt("Acme")).state, txt("Delhi 110001")).state, txt("x")).state;
    expect(s.step).toBe("media");
    expect(keys(step(s, btn("done")).effects)).toEqual(["nudge_media"]);
    for (let i = 0; i < 8; i++) s = step(s, img(`m${i}`)).state;
    s = step(s, img("m0")).state;
    expect(s.data.media!.filter((m) => m.kind === "image")).toHaveLength(5);
    s = step(s, voice("a1")).state;
    s = step(s, voice("a2")).state;
    expect(s.data.media!.filter((m) => m.kind === "audio")).toHaveLength(1);
    expect(keys(step(s, txt("what")).effects)).toEqual(["nudge_media", "got_media"]);
    const failed = step(s, txt("done"), T0, { draft: false });
    expect(failed.state.step).toBe("media");
    expect(keys(failed.effects)).toContain("media_failed");
  });
  it("processing: waits; stuck processing recovers after timeout", () => {
    const s: FlowState = { ...consented(), step: "processing", data: { ...consented().data, media: [{ id: "m", kind: "image", mime: "image/jpeg" }], lastAt: T0.toISOString() } };
    expect(keys(step(s, txt("hello")).effects)).toEqual(["processing_wait"]);
    expect(step(s, txt("hello"), later(STUCK_PROCESSING_MS + 1)).state.step).toBe("collecting");
  });
  it("review: unclear input re-prompts, media starts a new draft, submit failure keeps review", () => {
    const base = consented();
    const s: FlowState = { ...base, step: "review", data: { ...base.data, businessId: "b1", listingId: "l1", draft: { title: "t", category: "c", price: "-", moq: "-" } } };
    expect(keys(step(s, txt("hmm")).effects)).toEqual(["review_prompt"]);
    expect(step(s, img()).state.step).toBe("collecting");
    const f = step(s, btn("submit"), T0, { submit: false });
    expect(f.state.step).toBe("review");
    expect(keys(f.effects)).toContain("submit_failed");
    expect(step(s, txt("edit")).effects[0]).toMatchObject({ key: "edit_link" });
  });
  it("done: text re-prompts", () => {
    const s: FlowState = { ...consented(), step: "done" };
    expect(keys(step(s, txt("thanks")).effects)).toEqual(["done_again"]);
  });
  it("help keeps state; restart keeps consent+business, or returns to language without consent", () => {
    const s = step(consented(), txt("Acme")).state;
    const h = step(s, txt("help"));
    expect(h.state.step).toBe("location");
    expect(keys(h.effects)).toEqual(["help", "ask_location"]);
    const r = step(s, txt("restart"));
    expect(r.state).toMatchObject({ step: "business_name", data: { consent: true } });
    const noConsent = step(step(initialState(), btn("lang_en")).state, txt("restart"));
    expect(noConsent.state.step).toBe("language");
    expect(noConsent.state.data.consent).toBeUndefined();
    const withBiz = step({ ...s, data: { ...s.data, businessId: "b1", personId: "p1" } }, txt("restart"));
    expect(withBiz.state.step).toBe("media");
  });
  it("unsupported input keeps the step and re-prompts", () => {
    const r = step(initialState(), { type: "other" });
    expect(keys(r.effects)).toEqual(["unsupported", "greet"]);
  });
  it("welcome-back prefix after a long pause, not on fresh language step", () => {
    const s = step(consented(), txt("Acme")).state;
    expect(keys(step(s, txt("hello"), later(RESUME_AFTER_MS + 1)).effects)[0]).toBe("resume");
    expect(keys(step(initialState(), txt("hi"), later(RESUME_AFTER_MS + 1)).effects)[0]).toBe("greet");
  });
});

describe("coerceState", () => {
  it("repairs corrupt state and refuses post-consent steps without consent", () => {
    expect(coerceState(null).step).toBe("language");
    expect(coerceState({ flow: "x" }).step).toBe("language");
    expect(coerceState({ flow: "seller_onboarding", step: "review", data: { lang: "en" } }).step).toBe("language");
    expect(coerceState({ flow: "seller_onboarding", step: "review", data: { lang: "xx", consent: true } }, "hi").data.lang).toBe("hi");
    expect(coerceState({ flow: "seller_onboarding", step: "consent", data: { lang: "en" } }).step).toBe("consent");
  });
});

// ---------------------------------------------------------------- property test (seeded, no extra deps)
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
}
const TEXTS = ["hi", "Hindi", "yes", "no", "haan", "Sharma Steel", "Ludhiana 141003", "done", "submit", "edit", "help", "restart", "STOP", "", "   ", "😀", "x".repeat(300), "http://x.y", "141003", "बंद", "{{oops}}", "0"];
const BUTTONS = ["lang_en", "lang_hi", "lang_more", "lang_zz", "consent_yes", "consent_no", "done", "submit", "edit", "junk"];
function randomInput(r: () => number): Input {
  const n = r();
  if (n < 0.45) return { type: "text", text: TEXTS[Math.floor(r() * TEXTS.length)]! };
  if (n < 0.75) return { type: "button", id: BUTTONS[Math.floor(r() * BUTTONS.length)]! };
  if (n < 0.9) return r() < 0.7 ? img(`m${Math.floor(r() * 9)}`) : voice(`a${Math.floor(r() * 3)}`);
  return { type: "other" };
}

describe("property: random inputs never crash or skip consent", () => {
  it("holds over 300 random conversations", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      let s = initialState();
      let now = T0.getTime();
      for (let n = 0; n < 40; n++) {
        now += r() < 0.1 ? RESUME_AFTER_MS * 2 : 1000;
        const t = transition(s, randomInput(r), new Date(now));
        // consent gate: side-effecting effects only ever come from a consented state
        for (const e of t.effects) if (e.t === "provision" || e.t === "draft" || e.t === "submit") expect(t.state.data.consent, `seed ${seed}`).toBe(true);
        let state = t.state;
        for (const e of t.effects) {
          if (e.t === "provision") state = applyProvisioned(state, r() < 0.8 ? { ok: true, personId: "p", businessId: "b" } : { ok: false }).state;
          if (e.t === "draft") state = applyDrafted(state, r() < 0.8 ? { ok: true, listingId: "l", draft: { title: "t", category: "c", price: "-", moq: "-" } } : { ok: false }).state;
          if (e.t === "submit") state = applySubmitted(state, { ok: r() < 0.8 }).state;
        }
        expect(STEPS).toContain(state.step);
        if (POST_CONSENT.has(state.step)) expect(state.data.consent, `seed ${seed} step ${state.step}`).toBe(true);
        s = state;
      }
    }
  });
});
