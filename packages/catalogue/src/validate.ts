import { DomainError } from "@cnote/core";
import { z } from "zod";
import type { CategoryView, ListingInput } from "./index";

export const LANGS = ["en", "hi", "kn", "ta", "te", "mr", "gu", "bn"] as const;

const attrValue = z.union([z.string().max(500), z.number().finite()]);
const base = {
  categoryId: z.uuid(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000),
  attributes: z.record(z.string().max(60), attrValue),
  pricePaise: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  priceUnit: z.string().trim().max(30).nullable(),
  moq: z.number().int().min(1).max(2_000_000_000).nullable(),
  moqUnit: z.string().trim().max(30).nullable(),
  hsn: z.string().regex(/^\d{2,8}$/, "HSN must be 2-8 digits").nullable(),
  language: z.enum(LANGS),
  imageUrls: z.array(z.string().min(1).max(2000)).max(10),
};
export const listingInputSchema = z.object(base);
export const listingPatchSchema = z.object(base).partial().strict();

export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new DomainError("validation", r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), r.error.issues);
  return r.data;
}

type Schema = CategoryView["attributeSchema"];

/** Normalises values to the schema's types (numeric strings → numbers, select case-insensitively → canonical option). */
export function coerceAttributes(schema: Schema, attrs: Record<string, string | number>): Record<string, string | number> {
  const out: Record<string, string | number> = { ...attrs };
  for (const f of schema.fields) {
    const v = out[f.key];
    if (v === undefined) continue;
    if (f.type === "number" && typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) out[f.key] = Number(v);
    if (f.type === "select" && typeof v === "string") {
      const opt = f.options?.find((o) => o.toLowerCase() === v.trim().toLowerCase());
      if (opt) out[f.key] = opt;
    }
    if (f.type === "text" && typeof v === "number") out[f.key] = String(v);
  }
  return out;
}

/** Publish-time validation of attributes against the category schema. Returns human-readable problems. */
export function validateAttributes(schema: Schema, attrs: Record<string, string | number>): string[] {
  const errs: string[] = [];
  for (const f of schema.fields) {
    const v = attrs[f.key];
    const empty = v === undefined || v === null || (typeof v === "string" && v.trim() === "");
    if (empty) {
      if (f.required) errs.push(`${f.label} is required`);
      continue;
    }
    if (f.type === "number" && (typeof v !== "number" || !Number.isFinite(v))) errs.push(`${f.label} must be a number`);
    if (f.type === "select" && !(f.options ?? []).includes(String(v))) errs.push(`${f.label} must be one of: ${(f.options ?? []).join(", ")}`);
    if (f.type === "text" && typeof v !== "string") errs.push(`${f.label} must be text`);
  }
  return errs;
}

/** Fields required on every listing at publish time, independent of category. */
export function validatePublishable(l: Pick<ListingInput, "title" | "description">): string[] {
  const errs: string[] = [];
  if (l.title.trim().length < 3) errs.push("Title must be at least 3 characters");
  if (l.description.trim().length < 10) errs.push("Description must be at least 10 characters");
  return errs;
}

/** Text used for both moderation and embedding: what a buyer would match on. */
export function canonicalText(l: { title: string; description: string; attributes: Record<string, string | number> }, categoryName: string): string {
  const attrs = Object.entries(l.attributes).map(([k, v]) => `${k}: ${v}`).join(", ");
  return [l.title, categoryName, attrs, l.description].filter(Boolean).join("\n");
}
