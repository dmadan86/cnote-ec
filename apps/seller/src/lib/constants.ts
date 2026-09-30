export const LANGUAGES = [
  { code: "hi", label: "Hindi", native: "हिन्दी" },
  { code: "en", label: "English", native: "English" },
  { code: "kn", label: "Kannada", native: "ಕನ್ನಡ" },
  { code: "ta", label: "Tamil", native: "தமிழ்" },
  { code: "te", label: "Telugu", native: "తెలుగు" },
  { code: "mr", label: "Marathi", native: "मराठी" },
  { code: "gu", label: "Gujarati", native: "ગુજરાતી" },
  { code: "bn", label: "Bengali", native: "বাংলা" },
] as const;

/** Indian state names as stored (English). Labels are translated through the `states` namespace; see lib/states.ts. */
export { STATE_NAMES as STATES } from "./states";

export const UNITS = ["pcs", "kg", "meter", "set", "ton", "box", "litre", "pair"] as const;

export const TIER_LABELS = ["Phone verified", "GST verified", "KYC verified", "Audited"] as const;
