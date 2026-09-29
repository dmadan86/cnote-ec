import { DomainError } from "@cnote/core";
import Mustache from "mustache";
import sanitizeHtml from "sanitize-html";

// ---------------------------------------------------------------------------------------------
// Mustache safety. Staff content is logic-less: escaped {{var}} and sections only. Unescaped output
// ({{{x}}} / {{&x}}), partials, delimiter changes and lambdas-by-name are neutralised on save AND
// again before every render (defence in depth).
// ---------------------------------------------------------------------------------------------

const NAME = /^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)*$/;
// Logic-less means data only: never resolve Object.prototype members ({{constructor}}, {{__proto__}}, {{toString}}, ...).
const PROTO_KEYS = new Set(Object.getOwnPropertyNames(Object.prototype));
const isName = (n: string) => NAME.test(n) && !n.split(".").some((seg) => PROTO_KEYS.has(seg));
const TAG = /\{\{\{([\s\S]*?)\}\}\}|\{\{([\s\S]*?)\}\}/g;

/** Rewrites `{{{x}}}` and `{{&x}}` to escaped `{{x}}`; drops partials, delimiter switches and malformed tags. */
export function neutralizeMustache(src: string): string {
  return src.replace(TAG, (_m, triple: string | undefined, dbl: string | undefined) => {
    if (triple !== undefined) {
      const name = triple.trim().replace(/^&\s*/, "");
      return isName(name) || name === "." ? `{{${name}}}` : "";
    }
    const inner = (dbl ?? "").trim();
    if (inner === "" ) return "";
    const sigil = inner[0]!;
    if (sigil === "!") return `{{!${inner.slice(1).replace(/[{}]/g, "")}}}`;
    if (sigil === ">" || sigil === "=" || sigil === "<" || sigil === "$" || sigil === "~") return "";
    if (sigil === "&") {
      const n = inner.slice(1).trim();
      return isName(n) ? `{{${n}}}` : "";
    }
    if (sigil === "#" || sigil === "^" || sigil === "/") {
      const n = inner.slice(1).trim();
      return isName(n) ? `{{${sigil}${n}}}` : "";
    }
    return isName(inner) || inner === "." ? `{{${inner}}}` : "";
  });
}

/** Names referenced by {{name}} / sections (top-level segment), for "unknown variable" warnings. */
export function referencedVariables(src: string): string[] {
  const out = new Set<string>();
  const walk = (tokens: unknown[]) => {
    for (const t of tokens as [string, string, number, number, unknown[]?][]) {
      if (["name", "#", "^", "&"].includes(t[0])) out.add(t[1].split(".")[0]!);
      if (t[4]) walk(t[4]);
    }
  };
  try {
    walk(Mustache.parse(src) as unknown[]);
  } catch {
    /* syntax errors are reported by assertValidSyntax */
  }
  return [...out];
}

export function assertValidSyntax(src: string, what = "Template"): void {
  try {
    Mustache.parse(src);
  } catch (e) {
    throw new DomainError("validation", `${what} has a syntax error: ${e instanceof Error ? e.message : "invalid tags"}. Check that every {{#section}} has a matching {{/section}}.`);
  }
}

// ---------------------------------------------------------------------------------------------
// HTML sanitiser (email allowlist)
// ---------------------------------------------------------------------------------------------

const VAR = String.raw`\{\{[\w.]+\}\}`;
// The style parser cannot read "{{var}}" (braces open a CSS block), so variables inside style attributes travel through
// the sanitiser as opaque tokens (mv0x<hex of name>x) and are restored afterwards.
const STYLE_TOKEN = String.raw`mv0x[0-9a-f]{2,80}x`;
const COLOR = new RegExp(String.raw`^(#[0-9a-f]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*[\d.]+\s*)?\)|[a-z]{3,20}|${STYLE_TOKEN})$`, "i");
const LEN = /^(-?\d+(\.\d+)?(px|%|em|rem)?|auto)(\s+(-?\d+(\.\d+)?(px|%|em|rem)?|auto)){0,3}$/i;
const SIZE = /^(\d+(\.\d+)?(px|%)|auto|none)$/i;
const STYLES = {
  color: [COLOR],
  "background-color": [COLOR],
  "text-align": [/^(left|right|center|justify)$/i],
  "font-weight": [/^(normal|bold|[1-9]00)$/i],
  "font-style": [/^(normal|italic)$/i],
  "text-decoration": [/^(none|underline|line-through)$/i],
  padding: [LEN],
  margin: [LEN],
  "border-radius": [LEN],
  width: [SIZE],
  "max-width": [SIZE],
};

export const TEMPLATE_ASSET_PATH = /^\/media\/template-assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IS_VAR_ONLY = new RegExp(`^${VAR}$`);

function isSafeImgSrc(src: string): boolean {
  if (TEMPLATE_ASSET_PATH.test(src) || IS_VAR_ONLY.test(src)) return true;
  try {
    const u = new URL(src);
    return u.protocol === "https:" && !u.username && !u.password;
  } catch {
    return false;
  }
}
const isSafeHref = (href: string) => /^(https?:\/\/|mailto:|\{\{)/i.test(href.trim()) && !/^\s*(javascript|data|vbscript):/i.test(href);

function options(): sanitizeHtml.IOptions {
  return {
    allowedTags: ["p", "h1", "h2", "h3", "strong", "b", "em", "i", "u", "s", "a", "ul", "ol", "li", "blockquote", "br", "hr", "img", "table", "thead", "tbody", "tr", "td", "th", "span", "div"],
    allowedAttributes: {
      a: ["href", "title", "target", "rel", "style"],
      img: ["src", "alt", "width", "height", "style"],
      table: ["width", "cellpadding", "cellspacing", "border", "align", "role", "style"],
      td: ["colspan", "rowspan", "align", "valign", "width", "style"],
      th: ["colspan", "rowspan", "align", "valign", "width", "style"],
      tr: ["style"],
      p: ["style"], h1: ["style"], h2: ["style"], h3: ["style"], blockquote: ["style"], li: ["style"], ul: ["style"], ol: ["style"], span: ["style"], div: ["style"],
    },
    allowedStyles: { "*": STYLES },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["https"] },
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    transformTags: {
      a: (tagName, attribs) => {
        const out: Record<string, string> = { ...attribs };
        if (out.href !== undefined && !isSafeHref(out.href)) delete out.href;
        if (out.target && out.target !== "_blank") delete out.target;
        if (out.target === "_blank") out.rel = "noopener noreferrer";
        else delete out.rel;
        return { tagName, attribs: out };
      },
      img: (tagName, attribs) => {
        const out: Record<string, string> = { ...attribs };
        if (out.src !== undefined && !isSafeImgSrc(out.src)) delete out.src;
        for (const k of ["width", "height"]) if (out[k] !== undefined && !/^\d{1,4}%?$/.test(out[k]!)) delete out[k];
        return { tagName, attribs: out };
      },
    },
    exclusiveFilter: (frame) => frame.tag === "img" && !frame.attribs.src,
  };
}

const STYLE_ATTR = /(\sstyle\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;
const tokenizeStyleVars = (html: string) =>
  html.replace(STYLE_ATTR, (_m, head: string, dq: string | undefined, sq: string | undefined) => {
    const v = (dq ?? sq ?? "").replace(/\{\{([\w.]+)\}\}/g, (_x, name: string) => `mv0x${Buffer.from(name).toString("hex")}x`);
    return `${head}"${v.replace(/"/g, "&quot;")}"`;
  });
const restoreStyleVars = (html: string) =>
  html.replace(/(\sstyle=")([^"]*)"/g, (_m, head: string, v: string) => `${head}${v.replace(/mv0x([0-9a-f]{2,80})x/g, (_x, hex: string) => {
    const name = Buffer.from(hex, "hex").toString();
    return /^[\w.]+$/.test(name) ? `{{${name}}}` : "";
  })}"`);

function sanitizeOnce(html: string): string {
  return neutralizeMustache(restoreStyleVars(sanitizeHtml(tokenizeStyleVars(neutralizeMustache(html)), options())));
}

/**
 * Sanitise staff-authored (or rendered) HTML for email. Idempotent: the parser can re-nest elements on re-parse
 * (e.g. `<p><p>`), so the pass is repeated until it reaches a fixed point. Mustache tags are neutralised first and last.
 */
export function sanitizeEmailHtml(html: string): string {
  let out = sanitizeOnce(html);
  for (let i = 0; i < 5; i++) {
    const next = sanitizeOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Validate + sanitise on save; throws DomainError("validation") for broken Mustache syntax. */
export function cleanEmailHtml(html: string, what = "Content"): string {
  const clean = sanitizeEmailHtml(html);
  assertValidSyntax(clean, what);
  return clean;
}

/** Plain-text channels (in_app / sms / whatsapp) and subjects: no HTML at all, Mustache neutralised. */
export function cleanPlainText(text: string, what = "Content", { multiline = true } = {}): string {
  let t = neutralizeMustache(text).replace(/\r\n?/g, "\n").replace(/<[^>]*>/g, "");
  if (!multiline) t = t.replace(/\s*\n\s*/g, " ");
  t = t.trim();
  assertValidSyntax(t, what);
  return t;
}

/** Convert email HTML to a readable plain-text alternative. */
export function htmlToText(html: string): string {
  let h = html
    .replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, "")
    .replace(/<span[^>]*display:\s*none[^>]*>[\s\S]*?<\/span>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n----------\n")
    .replace(/<\/(p|div|h[1-6]|tr|table|blockquote|ul|ol)>/gi, "\n\n")
    .replace(/<\/t[dh]>/gi, "  ")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, (_m, alt: string) => (alt ? `[${alt}]` : ""))
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
      const label = text.replace(/<[^>]*>/g, "").trim();
      const url = href.replace(/&amp;/g, "&");
      return !label || label === url ? url : `${label} (${url})`;
    });
  h = sanitizeHtml(h, { allowedTags: [], allowedAttributes: {} });
  h = h
    .replace(/&nbsp;|\u00a0/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);/g, "'")
    .replace(/&amp;/g, "&");
  return h.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}
