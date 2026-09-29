import { DomainError } from "@cnote/core";
import juice from "juice";
import Mustache from "mustache";
import { htmlToText, neutralizeMustache, sanitizeEmailHtml } from "./sanitize";
import type { LayoutTheme, TemplateDefinition } from "./types";

export const FONT_FAMILIES: Record<string, string> = {
  "System sans-serif": "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  Arial: "Arial, Helvetica, sans-serif",
  Verdana: "Verdana, Geneva, sans-serif",
  Tahoma: "Tahoma, Geneva, sans-serif",
  Georgia: "Georgia, 'Times New Roman', serif",
  "Times New Roman": "'Times New Roman', Times, serif",
};

export const DEFAULT_THEME: LayoutTheme = {
  primaryColor: "#5b2fd6",
  accentColor: "#f97316",
  backgroundColor: "#f8f9fc",
  textColor: "#111827",
  fontFamily: FONT_FAMILIES["System sans-serif"]!,
  logoAssetId: null,
};

const HEX = /^#[0-9a-f]{6}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate untrusted theme input; unknown keys dropped, bad values rejected. */
export function parseTheme(raw: unknown): LayoutTheme {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const color = (k: keyof LayoutTheme) => {
    const v = r[k];
    if (v === undefined || v === null || v === "") return DEFAULT_THEME[k] as string;
    if (typeof v !== "string" || !HEX.test(v)) throw new DomainError("validation", `Theme colour "${k}" must be a #rrggbb value.`);
    return v.toLowerCase();
  };
  let fontFamily = DEFAULT_THEME.fontFamily;
  if (typeof r.fontFamily === "string" && r.fontFamily) {
    if (!Object.values(FONT_FAMILIES).includes(r.fontFamily)) throw new DomainError("validation", "Choose a font from the list.");
    fontFamily = r.fontFamily;
  }
  let logoAssetId: string | null = null;
  if (typeof r.logoAssetId === "string" && r.logoAssetId) {
    if (!UUID.test(r.logoAssetId)) throw new DomainError("validation", "Invalid logo asset.");
    logoAssetId = r.logoAssetId.toLowerCase();
  }
  return { primaryColor: color("primaryColor"), accentColor: color("accentColor"), backgroundColor: color("backgroundColor"), textColor: color("textColor"), fontFamily, logoAssetId };
}

/** Code fallback layout (also seeded as the "default" layout v1). Uses {{brand.*}} variables so it follows the theme. */
export const DEFAULT_LAYOUT = {
  headerHtml:
    '<div style="background-color: {{brand.primaryColor}}; padding: 20px 24px; text-align: left"><p><span style="color: #ffffff"><strong>{{brand.name}}</strong></span></p></div>',
  footerHtml:
    '<p style="text-align: center"><span style="color: #6b7280">{{brand.name}}, {{brand.address}}</span></p>' +
    '<p style="text-align: center"><span style="color: #6b7280">Need help? <a href="mailto:{{brand.supportEmail}}">Contact support</a></span></p>' +
    '<p style="text-align: center"><span style="color: #6b7280">Why am I receiving this? {{whyReceiving}}</span></p>' +
    '{{#unsubscribeUrl}}<p style="text-align: center"><span style="color: #6b7280"><a href="{{unsubscribeUrl}}">Unsubscribe</a> from these emails.</span></p>{{/unsubscribeUrl}}',
  theme: DEFAULT_THEME,
};

export const appUrl = () => (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");

const escapeHtml = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const identity = (s: unknown) => String(s);

/** Logic-less render. `html` escapes values for HTML; otherwise values are inserted verbatim (subjects, SMS, in-app). */
export function renderMustache(template: string, view: unknown, html: boolean): string {
  const safe = neutralizeMustache(template);
  return Mustache.render(safe, view, undefined, { escape: html ? escapeHtml : identity });
}

export function checkRequired(def: TemplateDefinition | undefined, vars: Record<string, unknown>): void {
  if (!def) return;
  const missing = def.variables.filter((v) => v.required && (vars[v.name] === undefined || vars[v.name] === null || vars[v.name] === "")).map((v) => v.name);
  if (missing.length) throw new DomainError("validation", `Missing required variable(s) for ${def.key}: ${missing.join(", ")}`, { missing });
}

const WHY: Record<string, string> = {
  transactional: "This is a service message about your account or activity on the marketplace.",
  security: "This is a security notice about your account. You receive these regardless of marketing preferences.",
  marketing: "You opted in to product updates and offers.",
};

/** The variable bag every template sees: caller vars + brand + footer helpers. */
export function buildView(vars: Record<string, unknown>, category: string, theme: LayoutTheme): Record<string, unknown> {
  const base = appUrl();
  return {
    ...vars,
    brand: {
      name: process.env.BRAND_NAME ?? "BizKart",
      address: process.env.BRAND_ADDRESS ?? "[Company registered address]",
      supportEmail: process.env.SUPPORT_EMAIL ?? "support@bizkart.example",
      appUrl: base,
      logoUrl: theme.logoAssetId ? `/media/template-assets/${theme.logoAssetId}` : "",
      primaryColor: theme.primaryColor,
      accentColor: theme.accentColor,
    },
    whyReceiving: WHY[category] ?? WHY.transactional,
    unsubscribeUrl: category === "marketing" ? String(vars.unsubscribeUrl ?? `${base}/account/notifications`) : "",
    year: String(new Date().getFullYear()),
  };
}

export interface AssembleInput {
  subject: string;
  preheader: string | null;
  bodyHtml: string; // already rendered + sanitised
  headerHtml: string; // already rendered + sanitised
  footerHtml: string; // already rendered + sanitised
  theme: LayoutTheme;
}

/** 600px table-based responsive wrapper → CSS inlined by juice. */
export function assembleEmailHtml(i: AssembleInput): string {
  const t = i.theme;
  const logo = t.logoAssetId
    ? `<div class="logo"><img src="${escapeHtml(`/media/template-assets/${t.logoAssetId}`)}" alt="${escapeHtml(process.env.BRAND_NAME ?? "BizKart")}" height="40" style="display:block;border:0;height:40px;max-width:200px"></div>`
    : "";
  const pre = i.preheader ? `<span class="preheader" style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${escapeHtml(i.preheader)}${"&nbsp;&zwnj;".repeat(40)}</span>` : "";
  const css = `
body{margin:0;padding:0;background-color:${t.backgroundColor};color:${t.textColor};font-family:${t.fontFamily};font-size:16px;line-height:1.55;-webkit-text-size-adjust:100%}
table{border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0}
img{border:0;max-width:100%;height:auto;-ms-interpolation-mode:bicubic}
.outer{background-color:${t.backgroundColor}}
.container{width:600px;max-width:600px}
.logo{padding:16px 24px 0 24px;background-color:#ffffff}
.content{background-color:#ffffff;padding:24px;font-size:16px;color:${t.textColor}}
.footer{padding:20px 24px;font-size:12px;line-height:1.5;color:#6b7280}
.content p,.footer p{margin:0 0 14px 0}
.content h1{font-size:24px;line-height:1.25;margin:0 0 14px 0;color:${t.textColor}}
.content h2{font-size:20px;line-height:1.3;margin:0 0 12px 0;color:${t.textColor}}
.content h3{font-size:17px;line-height:1.3;margin:0 0 10px 0;color:${t.textColor}}
.content a{color:${t.primaryColor};text-decoration:underline}
.footer a{color:#6b7280;text-decoration:underline}
.content blockquote{margin:0 0 14px 0;padding:4px 0 4px 14px;border-left:3px solid ${t.accentColor};color:#4b5563}
.content hr{border:0;border-top:1px solid #e5e7eb;margin:20px 0}
.content ul,.content ol{margin:0 0 14px 0;padding-left:22px}
.content td,.content th{padding:6px 8px;border:1px solid #e5e7eb;vertical-align:top}
@media only screen and (max-width:620px){.container{width:100%!important;max-width:100%!important}.content{padding:20px 16px!important}.footer{padding:16px!important}}`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="light"><title>${escapeHtml(i.subject)}</title><style>${css}</style></head>
<body>${pre}
<table role="presentation" class="outer" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0">
<tr><td class="header">${logo}${i.headerHtml}</td></tr>
<tr><td class="content">${i.bodyHtml}</td></tr>
<tr><td class="footer">${i.footerHtml}</td></tr>
</table></td></tr></table></body></html>`;
  return juice(html, { preserveMediaQueries: true, removeStyleTags: true, applyWidthAttributes: false });
}

export { htmlToText, sanitizeEmailHtml };
