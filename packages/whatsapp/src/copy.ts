// WhatsApp message copy. Words live in the DB template studio (channel "whatsapp"); code registers keys, variables and
// the English defaults. Hindi defaults are in code too (HI_DEFAULTS) and are used when no Hindi row exists in the DB.
import { defineTemplates, previewText, renderText, type TemplateDefinition } from "@cnote/templates";

export type Lang = "en" | "hi" | "kn" | "ta" | "te" | "mr" | "gu" | "bn";
export const LANGUAGES: Record<Lang, string> = { en: "English", hi: "हिंदी", kn: "ಕನ್ನಡ", ta: "தமிழ்", te: "తెలుగు", mr: "मराठी", gu: "ગુજરાતી", bn: "বাংলা" };
export const isLang = (v: unknown): v is Lang => typeof v === "string" && v in LANGUAGES;

const v = (name: string, description: string, example: string) => ({ name, description, example });

interface CopyDef { name: string; description: string; vars: ReturnType<typeof v>[]; en: string; hi: string }

const COPY: Record<string, CopyDef> = {
  greet: {
    name: "WhatsApp: greeting", description: "First message: language choice (shown before the language is known, so bilingual).", vars: [],
    en: "Namaste! Welcome to cnote, the marketplace where Indian businesses sell to verified buyers.\nनमस्ते! cnote में आपका स्वागत है।\n\nChoose your language / अपनी भाषा चुनें:",
    hi: "नमस्ते! cnote में आपका स्वागत है।\n\nअपनी भाषा चुनें / Choose your language:",
  },
  language_more: { name: "WhatsApp: more languages", description: "Language list prompt.", vars: [], en: "Pick your language:", hi: "अपनी भाषा चुनें:" },
  consent: {
    name: "WhatsApp: consent", description: "DPDP consent explanation before any data is processed (ADR-010).", vars: [],
    en: "Before we start: we will save your business details, photos and voice notes to create your product listing, and share your listing with buyers who search for it. Voice notes are deleted after they are turned into text. You can send STOP any time to stop messages. Do you agree?",
    hi: "शुरू करने से पहले: आपका लिस्टिंग बनाने के लिए हम आपके व्यवसाय की जानकारी, फ़ोटो और वॉइस नोट सहेजेंगे, और खरीदारों को आपकी लिस्टिंग दिखाएँगे। वॉइस नोट टेक्स्ट बनने के बाद हटा दिए जाते हैं। संदेश रोकने के लिए कभी भी STOP भेजें। क्या आप सहमत हैं?",
  },
  consent_declined: {
    name: "WhatsApp: consent declined", description: "Sent when the seller does not agree.", vars: [],
    en: "No problem, we have not saved anything. Send \"Hi\" whenever you want to start again.",
    hi: "कोई बात नहीं, हमने कुछ भी सहेजा नहीं है। दोबारा शुरू करने के लिए \"Hi\" भेजें।",
  },
  ask_business_name: { name: "WhatsApp: business name", description: "Ask for the business name.", vars: [], en: "Thank you! What is your business name?", hi: "धन्यवाद! आपके व्यवसाय का नाम क्या है?" },
  ask_location: {
    name: "WhatsApp: location", description: "Ask for city and pincode.", vars: [v("businessName", "Business name", "Sharma Steel")],
    en: "Nice, {{businessName}}. Which city are you in, and what is your 6-digit pincode? (Example: Ludhiana 141003)",
    hi: "बहुत अच्छा, {{businessName}}। आप किस शहर में हैं और आपका 6 अंकों का पिनकोड क्या है? (उदाहरण: Ludhiana 141003)",
  },
  invalid_location: {
    name: "WhatsApp: invalid location", description: "Pincode not understood.", vars: [],
    en: "I could not find a 6-digit pincode. Please send your city and pincode, for example: Ludhiana 141003.",
    hi: "6 अंकों का पिनकोड नहीं मिला। कृपया शहर और पिनकोड भेजें, जैसे: Ludhiana 141003।",
  },
  invalid_name: { name: "WhatsApp: invalid business name", description: "Business name not usable.", vars: [], en: "Please send your business name in a short text message (2 to 100 characters).", hi: "कृपया अपने व्यवसाय का नाम छोटे टेक्स्ट में भेजें (2 से 100 अक्षर)।" },
  ask_media: {
    name: "WhatsApp: ask for product media", description: "Prompt to send product photo(s) and/or a voice note.", vars: [],
    en: "Your seller profile is ready! Now send a photo of your product and/or a voice note describing it (price, size, minimum order). I will make the listing for you.",
    hi: "आपकी सेलर प्रोफ़ाइल तैयार है! अब अपने प्रोडक्ट की फ़ोटो और/या उसके बारे में एक वॉइस नोट भेजें (दाम, साइज़, न्यूनतम ऑर्डर)। लिस्टिंग मैं बना दूँगा।",
  },
  got_media: {
    name: "WhatsApp: media received", description: "Acknowledge the first media; more can follow.", vars: [],
    en: "Got it! Send more photos or a voice note if you like, then tap Done.",
    hi: "मिल गया! चाहें तो और फ़ोटो या वॉइस नोट भेजें, फिर हो गया दबाएँ।",
  },
  nudge_media: { name: "WhatsApp: nudge for media", description: "Text received while waiting for media.", vars: [], en: "Please send a product photo or a voice note.", hi: "कृपया प्रोडक्ट की फ़ोटो या वॉइस नोट भेजें।" },
  processing: { name: "WhatsApp: processing", description: "AI draft is being created.", vars: [], en: "Thank you, creating your listing draft. This takes about a minute.", hi: "धन्यवाद, आपकी लिस्टिंग का ड्राफ़्ट बन रहा है। इसमें लगभग एक मिनट लगेगा।" },
  draft_summary: {
    name: "WhatsApp: draft summary", description: "Summary of the AI draft with confirm/edit buttons.",
    vars: [v("title", "Draft title", "Stainless steel pipe 2 inch"), v("category", "Category name", "Industrial supplies"), v("price", "Price text or a dash", "Rs 250 / kg"), v("moq", "Minimum order or a dash", "100 kg")],
    en: "Here is your draft:\n*{{title}}*\nCategory: {{category}}\nPrice: {{price}}\nMinimum order: {{moq}}\n\nLooks good? We check every listing before it goes live.",
    hi: "आपका ड्राफ़्ट:\n*{{title}}*\nश्रेणी: {{category}}\nदाम: {{price}}\nन्यूनतम ऑर्डर: {{moq}}\n\nठीक है? लाइव होने से पहले हम हर लिस्टिंग जाँचते हैं।",
  },
  submitted: {
    name: "WhatsApp: submitted", description: "Listing submitted for review.", vars: [v("sellerUrl", "Seller app link", "https://seller.example.com/listings")],
    en: "Done! Your listing was sent for review and goes live once approved. Manage everything here: {{sellerUrl}}\nSend another photo any time to add one more product.",
    hi: "हो गया! आपकी लिस्टिंग समीक्षा के लिए भेज दी गई है और मंज़ूरी के बाद लाइव होगी। यहाँ सब कुछ सँभालें: {{sellerUrl}}\nएक और प्रोडक्ट जोड़ने के लिए कभी भी फ़ोटो भेजें।",
  },
  edit_link: { name: "WhatsApp: edit on web", description: "Deep link to the seller app editor.", vars: [v("editUrl", "Edit link", "https://seller.example.com/listings/1/edit")], en: "Edit your listing here, then submit it from the web: {{editUrl}}", hi: "अपनी लिस्टिंग यहाँ बदलें और वेब से जमा करें: {{editUrl}}" },
  review_prompt: { name: "WhatsApp: review prompt", description: "Unclear reply while reviewing the draft.", vars: [], en: "Tap a button: submit your listing for review, or edit it on the web.", hi: "एक बटन दबाएँ: लिस्टिंग समीक्षा के लिए जमा करें, या वेब पर बदलें।" },
  media_failed: { name: "WhatsApp: media failed", description: "Draft could not be created.", vars: [], en: "Sorry, I could not create a listing from that. Please send a clearer photo or a voice note.", hi: "क्षमा करें, इससे लिस्टिंग नहीं बन सकी। कृपया साफ़ फ़ोटो या वॉइस नोट भेजें।" },
  submit_failed: { name: "WhatsApp: submit failed", description: "Submission rejected (validation).", vars: [v("editUrl", "Edit link", "https://seller.example.com/listings/1/edit")], en: "Your listing needs a few more details before review. Please complete it here: {{editUrl}}", hi: "समीक्षा से पहले लिस्टिंग में कुछ जानकारी और चाहिए। कृपया यहाँ पूरी करें: {{editUrl}}" },
  provision_failed: { name: "WhatsApp: profile failed", description: "Could not create the seller profile.", vars: [], en: "Sorry, something went wrong while creating your profile. Please send your city and pincode again.", hi: "क्षमा करें, प्रोफ़ाइल बनाते समय कुछ गड़बड़ हुई। कृपया शहर और पिनकोड फिर से भेजें।" },
  processing_wait: { name: "WhatsApp: still processing", description: "Message while the draft is being made.", vars: [], en: "Still working on your listing, one moment please.", hi: "आपकी लिस्टिंग पर अभी काम चल रहा है, कृपया थोड़ा रुकें।" },
  done_again: { name: "WhatsApp: already done", description: "After onboarding: any other text.", vars: [v("sellerUrl", "Seller app link", "https://seller.example.com")], en: "You are all set. Send a photo of another product to add a listing, or manage your account here: {{sellerUrl}}", hi: "आप तैयार हैं। नई लिस्टिंग के लिए किसी और प्रोडक्ट की फ़ोटो भेजें, या यहाँ अकाउंट सँभालें: {{sellerUrl}}" },
  resume: { name: "WhatsApp: welcome back", description: "Prefix when a seller returns after a long pause.", vars: [], en: "Welcome back! Let us continue where we stopped.", hi: "फिर से स्वागत है! जहाँ रुके थे वहीं से आगे बढ़ते हैं।" },
  help: {
    name: "WhatsApp: help", description: "Help text.", vars: [],
    en: "I can help you list your products on cnote. Send \"restart\" to start over, or STOP to stop messages. You can also use the web app any time.",
    hi: "मैं cnote पर आपके प्रोडक्ट लिस्ट करने में मदद करता हूँ। दोबारा शुरू करने के लिए \"restart\" भेजें, संदेश रोकने के लिए STOP। आप वेब ऐप भी इस्तेमाल कर सकते हैं।",
  },
  restarted: { name: "WhatsApp: restarted", description: "Conversation restarted.", vars: [], en: "Okay, starting over.", hi: "ठीक है, फिर से शुरू करते हैं।" },
  unsupported: { name: "WhatsApp: unsupported message", description: "Stickers, video, documents, etc.", vars: [], en: "I can read text, photos and voice notes. Please send one of those.", hi: "मैं टेक्स्ट, फ़ोटो और वॉइस नोट समझ सकता हूँ। कृपया इनमें से कोई भेजें।" },
  opted_out: { name: "WhatsApp: opted out", description: "Confirmation of STOP.", vars: [], en: "You will not get any more messages from us. Send START if you change your mind.", hi: "अब आपको हमारी ओर से कोई संदेश नहीं मिलेगा। मन बदले तो START भेजें।" },
  opted_in: { name: "WhatsApp: opted back in", description: "Confirmation of START.", vars: [], en: "Welcome back! Send \"Hi\" to continue.", hi: "फिर से स्वागत है! जारी रखने के लिए \"Hi\" भेजें।" },
};

export const templateKey = (k: string) => `whatsapp.${k}`;

export const whatsappTemplateDefinitions: TemplateDefinition[] = Object.entries(COPY).map(([k, c]) => ({
  key: templateKey(k), name: c.name, description: c.description, category: "transactional", channels: ["whatsapp"],
  variables: c.vars, defaults: { whatsapp: { body: c.en } },
}));
defineTemplates(whatsappTemplateDefinitions);

/** Hindi defaults for the admin template studio (create locale "hi" rows from these). */
export const HI_DEFAULTS: Record<string, string> = Object.fromEntries(Object.entries(COPY).map(([k, c]) => [templateKey(k), c.hi]));
export const copyKeys = () => Object.keys(COPY);

const BUTTONS: Record<string, { en: string; hi: string }> = {
  consent_yes: { en: "I agree", hi: "मैं सहमत हूँ" },
  consent_no: { en: "No thanks", hi: "नहीं" },
  done: { en: "Done", hi: "हो गया" },
  submit: { en: "Looks good", hi: "ठीक है, जमा करें" },
  edit: { en: "Edit on web", hi: "वेब पर बदलें" },
  more: { en: "More languages", hi: "अन्य भाषाएँ" },
  choose: { en: "Choose", hi: "चुनें" },
};
export const buttonLabel = (id: string, lang: Lang): string => {
  if (id.startsWith("lang_")) {
    const l = id.slice(5);
    if (l === "more") return BUTTONS.more![lang === "hi" ? "hi" : "en"];
    return isLang(l) ? LANGUAGES[l] : id;
  }
  return BUTTONS[id]?.[lang === "hi" ? "hi" : "en"] ?? id;
};

/** DB template (locale → en → code default); Hindi falls back to the in-code Hindi default when the DB has no Hindi row. */
export async function renderCopy(key: string, lang: Lang, vars: Record<string, unknown> = {}): Promise<string> {
  const k = templateKey(key);
  if (lang === "en") return (await renderText(k, "whatsapp", vars, { locale: "en" })).body;
  const local = await renderText(k, "whatsapp", vars, { locale: lang });
  if (lang === "hi") {
    const en = await renderText(k, "whatsapp", vars, { locale: "en" });
    if (local.templateVersionId === en.templateVersionId) {
      const hi = HI_DEFAULTS[k];
      if (hi) return (await previewText({ key: k, channel: "whatsapp", title: null, body: hi, vars })).body;
    }
  }
  return local.body;
}
