// Buyer location for geo-targeted sponsored slots (ADR-009 ads gap). The "Deliver to" picker stores a 6-digit pincode in
// the non-httpOnly `cnote_pincode` cookie (features/shell/pincode-picker.tsx). State is derived from the PIN's leading
// digits (India Post circles), a best-effort mapping: it only widens matching for campaigns that target a state.

/** 3-digit PIN prefixes whose state differs from the 2-digit default below (the notable exceptions only). */
const PREFIX3: Record<string, string> = {
  "160": "Chandigarh", "244": "Uttar Pradesh", "246": "Uttarakhand", "248": "Uttarakhand", "249": "Uttarakhand", "262": "Uttarakhand", "263": "Uttarakhand",
  "403": "Goa", "737": "Sikkim", "744": "Andaman and Nicobar Islands", "605": "Puducherry", "533": "Andhra Pradesh", "682": "Kerala",
  "790": "Arunachal Pradesh", "791": "Arunachal Pradesh", "792": "Arunachal Pradesh", "793": "Meghalaya", "794": "Meghalaya", "795": "Manipur",
  "796": "Mizoram", "797": "Nagaland", "798": "Nagaland", "799": "Tripura", "785": "Assam", "786": "Assam", "787": "Assam", "788": "Assam", "781": "Assam", "782": "Assam", "783": "Assam", "784": "Assam",
  "180": "Jammu and Kashmir", "181": "Jammu and Kashmir", "182": "Jammu and Kashmir", "184": "Jammu and Kashmir", "185": "Jammu and Kashmir", "190": "Jammu and Kashmir", "191": "Jammu and Kashmir", "192": "Jammu and Kashmir", "193": "Jammu and Kashmir", "194": "Ladakh",
  "814": "Jharkhand", "815": "Jharkhand", "816": "Jharkhand", "825": "Jharkhand", "826": "Jharkhand", "827": "Jharkhand", "828": "Jharkhand", "829": "Jharkhand", "831": "Jharkhand", "832": "Jharkhand", "833": "Jharkhand", "834": "Jharkhand", "835": "Jharkhand",
  "396": "Gujarat", "370": "Gujarat",
};
const PREFIX2: Record<string, string> = {
  "11": "Delhi", "12": "Haryana", "13": "Haryana", "14": "Punjab", "15": "Punjab", "16": "Punjab", "17": "Himachal Pradesh", "18": "Jammu and Kashmir", "19": "Jammu and Kashmir",
  "20": "Uttar Pradesh", "21": "Uttar Pradesh", "22": "Uttar Pradesh", "23": "Uttar Pradesh", "24": "Uttar Pradesh", "25": "Uttar Pradesh", "26": "Uttar Pradesh", "27": "Uttar Pradesh", "28": "Uttar Pradesh",
  "30": "Rajasthan", "31": "Rajasthan", "32": "Rajasthan", "33": "Rajasthan", "34": "Rajasthan", "36": "Gujarat", "37": "Gujarat", "38": "Gujarat", "39": "Gujarat",
  "40": "Maharashtra", "41": "Maharashtra", "42": "Maharashtra", "43": "Maharashtra", "44": "Maharashtra", "45": "Madhya Pradesh", "46": "Madhya Pradesh", "47": "Madhya Pradesh", "48": "Madhya Pradesh", "49": "Chhattisgarh",
  "50": "Telangana", "51": "Andhra Pradesh", "52": "Andhra Pradesh", "53": "Andhra Pradesh", "56": "Karnataka", "57": "Karnataka", "58": "Karnataka", "59": "Karnataka",
  "60": "Tamil Nadu", "61": "Tamil Nadu", "62": "Tamil Nadu", "63": "Tamil Nadu", "64": "Tamil Nadu", "67": "Kerala", "68": "Kerala", "69": "Kerala",
  "70": "West Bengal", "71": "West Bengal", "72": "West Bengal", "73": "West Bengal", "74": "West Bengal", "75": "Odisha", "76": "Odisha", "77": "Odisha", "78": "Assam", "79": "Arunachal Pradesh",
  "80": "Bihar", "81": "Bihar", "82": "Bihar", "83": "Jharkhand", "84": "Bihar", "85": "Bihar",
};

/** A valid Indian PIN is 6 digits, first digit 1-9. Anything else is treated as "no location". */
export const validPincode = (v: string | null | undefined): string | null => (v && /^[1-9]\d{5}$/.test(v) ? v : null);

export function stateFromPincode(pin: string | null | undefined): string | null {
  const p = validPincode(pin);
  return p ? (PREFIX3[p.slice(0, 3)] ?? PREFIX2[p.slice(0, 2)] ?? null) : null;
}

export interface BuyerLocation {
  buyerPincode: string | null;
  buyerState: string | null;
}

/** From the raw cookie value. Never throws; an invalid cookie is "unknown location" (geo-restricted campaigns then do not match). */
export function buyerLocation(pincodeCookie: string | null | undefined): BuyerLocation {
  const buyerPincode = validPincode(pincodeCookie);
  return { buyerPincode, buyerState: stateFromPincode(buyerPincode) };
}
