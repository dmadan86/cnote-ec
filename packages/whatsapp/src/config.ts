export const DAY_MS = 86_400_000;
export const WINDOW_MS = DAY_MS;
export const RETENTION_DAYS = 30;
export const SELLER_APP_URL = () => (process.env.SELLER_APP_URL ?? process.env.NEXT_PUBLIC_SELLER_URL ?? "http://localhost:3002").replace(/\/$/, "");

export interface MetaConfig {
  phoneNumberId: string;
  accessToken: string;
  appSecret: string | undefined;
  verifyToken: string | undefined;
  apiVersion: string;
  graphUrl: string;
}

export function metaConfig(env: Record<string, string | undefined> = process.env): MetaConfig {
  return {
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ?? "",
    accessToken: env.WHATSAPP_ACCESS_TOKEN ?? "",
    appSecret: env.WHATSAPP_APP_SECRET,
    verifyToken: env.WHATSAPP_VERIFY_TOKEN,
    apiVersion: env.WHATSAPP_API_VERSION ?? "v23.0",
    graphUrl: (env.WHATSAPP_GRAPH_URL ?? "https://graph.facebook.com").replace(/\/$/, ""),
  };
}

/**
 * Estimated per-message price in paise for business-initiated templates (India rate card; verify against
 * Meta's pricing page, rates change quarterly). Service replies inside the 24h window are treated as free.
 */
export const TEMPLATE_COST_PAISE = { authentication: 12, utility: 12, marketing: 87 } as const;
export type TemplateCategory = keyof typeof TEMPLATE_COST_PAISE;
