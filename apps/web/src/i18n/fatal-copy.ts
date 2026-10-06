// Page-level failure copy that must render WITHOUT next-intl: app/global-error.tsx has no layout (so no provider), and
// app/error.tsx / app/not-found.tsx also run when a locale layout above them has failed. Importing messages/<locale>.json
// would ship every catalogue string to those bundles, so this is a tiny mirror of the `errors` namespace keys below.
// test/fatal-copy.test.ts fails if it drifts from messages/<locale>.json (the catalogues stay the source of truth).
import type { Locale } from "./config";

export const FATAL_KEYS = ["notFoundCode","notFoundTitle","notFoundText","goHome","searchProducts","errorTitle","errorText","tryAgain","reference"] as const;
export type FatalCopy = Record<(typeof FATAL_KEYS)[number], string>;

export const FATAL_COPY: Record<Locale, FatalCopy> = {
  en: {
    notFoundCode: "404",
    notFoundTitle: "We could not find that page",
    notFoundText: "The link may be old or the product may no longer be listed.",
    goHome: "Go to home",
    searchProducts: "Search products",
    errorTitle: "Something went wrong",
    errorText: "We could not load this page. Please try again. If it keeps happening, come back in a few minutes.",
    tryAgain: "Try again",
    reference: "Reference",
  },
  hi: {
    notFoundCode: "404",
    notFoundTitle: "हमें वह पेज नहीं मिला",
    notFoundText: "हो सकता है लिंक पुराना हो या प्रोडक्ट अब लिस्ट में न हो।",
    goHome: "होम पर जाएँ",
    searchProducts: "प्रोडक्ट खोजें",
    errorTitle: "कुछ गड़बड़ हो गई",
    errorText: "हम यह पेज लोड नहीं कर सके। कृपया फिर कोशिश करें। अगर बार-बार ऐसा हो, तो कुछ मिनट बाद आएँ।",
    tryAgain: "फिर कोशिश करें",
    reference: "संदर्भ",
  },
  kn: {
    notFoundCode: "404",
    notFoundTitle: "ಆ ಪುಟವನ್ನು ನಮಗೆ ಹುಡುಕಲಾಗಲಿಲ್ಲ",
    notFoundText: "ಲಿಂಕ್ ಹಳೆಯದಾಗಿರಬಹುದು ಅಥವಾ ಉತ್ಪನ್ನವನ್ನು ಇನ್ನು ಪಟ್ಟಿ ಮಾಡಿಲ್ಲದಿರಬಹುದು.",
    goHome: "ಮುಖಪುಟಕ್ಕೆ ಹೋಗಿ",
    searchProducts: "ಉತ್ಪನ್ನಗಳನ್ನು ಹುಡುಕಿ",
    errorTitle: "ಏನೋ ತಪ್ಪಾಗಿದೆ",
    errorText: "ಈ ಪುಟವನ್ನು ಲೋಡ್ ಮಾಡಲು ಸಾಧ್ಯವಾಗಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ. ಇದು ಮತ್ತೆ ಮತ್ತೆ ಆದರೆ, ಕೆಲವು ನಿಮಿಷಗಳ ನಂತರ ಮತ್ತೆ ಬನ್ನಿ.",
    tryAgain: "ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ",
    reference: "ಉಲ್ಲೇಖ",
  },
  ta: {
    notFoundCode: "404",
    notFoundTitle: "அந்தப் பக்கத்தை எங்களால் கண்டறிய இயலவில்லை",
    notFoundText: "இணைப்பு பழையதாக இருக்கலாம் அல்லது பொருள் இனி பட்டியலிடப்படாமல் இருக்கலாம்.",
    goHome: "முகப்புக்குச் செல்லுங்கள்",
    searchProducts: "பொருட்களைத் தேடுங்கள்",
    errorTitle: "ஏதோ தவறு நடந்துவிட்டது",
    errorText: "இந்தப் பக்கத்தை ஏற்ற இயலவில்லை. மீண்டும் முயலுங்கள். தொடர்ந்து நடந்தால், சில நிமிடங்கள் கழித்து வாருங்கள்.",
    tryAgain: "மீண்டும் முயலுங்கள்",
    reference: "குறிப்பு",
  },
  te: {
    notFoundCode: "404",
    notFoundTitle: "ఆ పేజీ మాకు కనబడలేదు",
    notFoundText: "లింక్ పాతది కావచ్చు లేదా ఉత్పత్తి ఇకపై లిస్ట్ చేయబడి ఉండకపోవచ్చు.",
    goHome: "హోమ్‌కు వెళ్లండి",
    searchProducts: "ఉత్పత్తులను వెతకండి",
    errorTitle: "ఏదో తప్పు జరిగింది",
    errorText: "ఈ పేజీని లోడ్ చేయలేకపోయాము. దయచేసి మళ్లీ ప్రయత్నించండి. ఇది పదేపదే జరిగితే, కొన్ని నిమిషాల తర్వాత తిరిగి రండి.",
    tryAgain: "మళ్లీ ప్రయత్నించండి",
    reference: "సూచన",
  },
  mr: {
    notFoundCode: "404",
    notFoundTitle: "आम्हाला ते पृष्ठ सापडले नाही",
    notFoundText: "लिंक जुनी असू शकते किंवा उत्पादन आता सूचीत नसू शकते.",
    goHome: "मुख्यपृष्ठावर जा",
    searchProducts: "उत्पादने शोधा",
    errorTitle: "काहीतरी चुकले",
    errorText: "आम्ही हे पृष्ठ लोड करू शकलो नाही. कृपया पुन्हा प्रयत्न करा. वारंवार असे होत असल्यास काही मिनिटांनी परत या.",
    tryAgain: "पुन्हा प्रयत्न करा",
    reference: "संदर्भ",
  },
  gu: {
    notFoundCode: "404",
    notFoundTitle: "અમને તે પેજ મળ્યું નથી",
    notFoundText: "લિંક જૂની હોઈ શકે અથવા ઉત્પાદન હવે યાદીમાં ન હોય.",
    goHome: "હોમ પર જાઓ",
    searchProducts: "ઉત્પાદનો શોધો",
    errorTitle: "કંઈક ખોટું થયું",
    errorText: "અમે આ પેજ લોડ કરી શક્યા નથી. કૃપા કરીને ફરી પ્રયાસ કરો. જો આમ વારંવાર થાય, તો થોડી મિનિટો પછી પાછા આવો.",
    tryAgain: "ફરી પ્રયાસ કરો",
    reference: "સંદર્ભ",
  },
  bn: {
    notFoundCode: "404",
    notFoundTitle: "আমরা সেই পৃষ্ঠাটি খুঁজে পাইনি",
    notFoundText: "লিংকটি পুরনো হতে পারে অথবা পণ্যটি হয়তো আর তালিকায় নেই।",
    goHome: "হোমে যান",
    searchProducts: "পণ্য অনুসন্ধান করুন",
    errorTitle: "কিছু ভুল হয়েছে",
    errorText: "আমরা এই পৃষ্ঠাটি লোড করতে পারিনি। অনুগ্রহ করে আবার চেষ্টা করুন। সমস্যা চলতে থাকলে কয়েক মিনিট পরে আবার আসুন।",
    tryAgain: "আবার চেষ্টা করুন",
    reference: "রেফারেন্স",
  },
};
