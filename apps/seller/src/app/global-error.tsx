"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect, useSyncExternalStore } from "react";

// Root-layout failures render outside the app shell (no next-intl provider), so this page brings its own tiny
// dictionary and picks the language from the `seller_locale` cookie. Falls back to English.
const COPY = {
  en: { title: "Something went wrong", body: "We've been notified and are looking into it.", reference: "Reference", retry: "Try again" },
  hi: { title: "कुछ गड़बड़ हो गई", body: "हमें इसकी सूचना मिल गई है, हम इसे देख रहे हैं।", reference: "संदर्भ", retry: "फिर से कोशिश करें" },
  kn: { title: "ಏನೋ ತಪ್ಪಾಗಿದೆ", body: "ನಮಗೆ ತಿಳಿಸಲಾಗಿದೆ, ನಾವು ಪರಿಶೀಲಿಸುತ್ತಿದ್ದೇವೆ.", reference: "ಉಲ್ಲೇಖ", retry: "ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ" },
  ta: { title: "ஏதோ தவறு நடந்துவிட்டது", body: "எங்களுக்குத் தகவல் கிடைத்துவிட்டது, நாங்கள் பார்த்து வருகிறோம்.", reference: "குறிப்பு", retry: "மீண்டும் முயற்சிக்கவும்" },
  te: { title: "ఏదో తప్పు జరిగింది", body: "మాకు సమాచారం అందింది, మేము పరిశీలిస్తున్నాము.", reference: "సూచన", retry: "మళ్లీ ప్రయత్నించండి" },
  mr: { title: "काहीतरी चूक झाली", body: "आम्हाला याची माहिती मिळाली आहे, आम्ही तपासत आहोत.", reference: "संदर्भ", retry: "पुन्हा प्रयत्न करा" },
  gu: { title: "કંઈક ખોટું થયું", body: "અમને જાણ થઈ ગઈ છે, અમે તપાસી રહ્યા છીએ.", reference: "સંદર્ભ", retry: "ફરી પ્રયાસ કરો" },
  bn: { title: "কিছু একটা ভুল হয়েছে", body: "আমরা জানতে পেরেছি, বিষয়টি দেখছি।", reference: "রেফারেন্স", retry: "আবার চেষ্টা করুন" },
} as const;
type Lang = keyof typeof COPY;

function cookieLang(): Lang {
  const m = /(?:^|;\s*)seller_locale=([^;]+)/.exec(document.cookie);
  const v = m?.[1];
  return v && v in COPY ? (v as Lang) : "en";
}

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const lang = useSyncExternalStore(() => () => {}, cookieLang, () => "en" as Lang);
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  const t = COPY[lang];

  return (
    <html lang={`${lang}-IN`}>
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "3rem 1.5rem", textAlign: "center", color: "#111827" }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700 }}>{t.title}</h1>
        <p style={{ color: "#6b7280", marginTop: "0.5rem" }}>{t.body}</p>
        {error.digest ? <p style={{ color: "#6b7280", fontSize: "0.75rem" }}>{t.reference}: {error.digest}</p> : null}
        <button
          onClick={reset}
          style={{ marginTop: "1.5rem", padding: "0.6rem 1.4rem", borderRadius: 999, border: 0, background: "#6d3ff0", color: "#fff", fontWeight: 600, cursor: "pointer" }}
        >
          {t.retry}
        </button>
      </body>
    </html>
  );
}
