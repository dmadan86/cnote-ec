// Rich text for storefront blocks is a tiny STRUCTURED subset, not HTML: paragraphs, bold, italic, https links and
// lists. Because it is data, there is nothing to "sanitise" at render time (no innerHTML anywhere) and an AI builder
// can generate it reliably. `parseMarkup`/`toMarkup` give the editor a plain-text authoring syntax:
//   blank line = new paragraph · "- " bullet · "1. " numbered · **bold** · *italic* · [label](https://…)
import { z } from "zod";

export const RICH_LIMITS = { blocks: 12, inlinesPerBlock: 40, items: 12, chars: 3000, href: 200 } as const;

const href = z
  .string()
  .max(RICH_LIMITS.href)
  .refine((v) => isSafeHref(v), "Links must start with https://");

const inline = z.strictObject({
  text: z.string().min(1).max(600),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  href: href.optional(),
});

const inlines = z.array(inline).min(1).max(RICH_LIMITS.inlinesPerBlock);

const block = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("p"), children: inlines }),
  z.strictObject({ type: z.literal("ul"), items: z.array(inlines).min(1).max(RICH_LIMITS.items) }),
  z.strictObject({ type: z.literal("ol"), items: z.array(inlines).min(1).max(RICH_LIMITS.items) }),
]);

export const richTextSchema = z
  .array(block)
  .max(RICH_LIMITS.blocks)
  .refine((rt) => richTextToPlain(rt as RichText).length <= RICH_LIMITS.chars, `Text is too long (max ${RICH_LIMITS.chars} characters).`);

export type Inline = z.infer<typeof inline>;
export type RichBlock = z.infer<typeof block>;
export type RichText = RichBlock[];

/** https only: no javascript:, data:, mailto: or tel: (contact details go through the platform RFQ, not raw links). */
export function isSafeHref(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.hostname.includes(".") && !u.username && !u.password;
  } catch {
    return false;
  }
}

const flatten = (xs: Inline[]) => xs.map((i) => i.text).join("");

export function richTextToPlain(rt: RichText): string {
  return rt.map((b) => (b.type === "p" ? flatten(b.children) : b.items.map(flatten).join("\n"))).join("\n\n");
}

const INLINE_RE = /\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const push = (text: string, extra: Partial<Inline> = {}) => {
    if (text) out.push({ text, ...extra });
  };
  for (const m of src.matchAll(INLINE_RE)) {
    push(src.slice(last, m.index));
    if (m[1] !== undefined) push(m[1], { bold: true });
    else if (m[2] !== undefined) push(m[2], { italic: true });
    else if (m[3] !== undefined && m[4] !== undefined) {
      // an unsafe URL degrades to plain text rather than a live link
      if (isSafeHref(m[4])) push(m[3], { href: m[4] });
      else push(m[3]);
    }
    last = (m.index ?? 0) + m[0].length;
  }
  push(src.slice(last));
  return out.length ? out : [{ text: src || " " }];
}

export function parseMarkup(markup: string): RichText {
  const blocks: RichText = [];
  for (const chunk of markup.replace(/\r\n/g, "\n").split(/\n{2,}/)) {
    const lines = chunk.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
    if (!lines.length) continue;
    const bullets = lines.every((l) => /^[-*]\s+/.test(l));
    const numbered = lines.every((l) => /^\d+[.)]\s+/.test(l));
    if (bullets) blocks.push({ type: "ul", items: lines.map((l) => parseInline(l.replace(/^[-*]\s+/, ""))) });
    else if (numbered) blocks.push({ type: "ol", items: lines.map((l) => parseInline(l.replace(/^\d+[.)]\s+/, ""))) });
    else blocks.push({ type: "p", children: parseInline(lines.map((l) => l.trim()).join(" ")) });
  }
  return blocks;
}

const inlineToMarkup = (i: Inline) => {
  if (i.href) return `[${i.text}](${i.href})`;
  if (i.bold) return `**${i.text}**`;
  if (i.italic) return `*${i.text}*`;
  return i.text;
};
const runsToMarkup = (xs: Inline[]) => xs.map(inlineToMarkup).join("");

export function toMarkup(rt: RichText): string {
  return rt
    .map((b) =>
      b.type === "p" ? runsToMarkup(b.children) : b.items.map((it, n) => `${b.type === "ul" ? "-" : `${n + 1}.`} ${runsToMarkup(it)}`).join("\n"),
    )
    .join("\n\n");
}

export const plainToRichText = (text: string): RichText => parseMarkup(text.replace(/[*[\]]/g, ""));
