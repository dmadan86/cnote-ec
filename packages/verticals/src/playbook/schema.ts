import { LANGS } from "@cnote/catalogue";
import { z } from "zod";
import { ClusterSchema, GatesSchema } from "../types";

/**
 * Vertical playbook (ADR-011/ADR-016) as pure data. A playbook describes a category tree, attribute schemas, units,
 * HSN codes and regulatory flags. Loading it into the database is an explicit action (`loadPlaybook`); nothing in
 * the product reads a playbook implicitly and no code path names a vertical.
 */

/** Canonical trade units for price and MOQ (stored lowercase in `Listing.priceUnit` / `moqUnit`). */
export const TRADE_UNITS = ["piece", "kg", "tonne", "meter", "roll", "sheet", "set", "pack", "carton", "bundle", "litre"] as const;
export type TradeUnit = (typeof TRADE_UNITS)[number];

/** Unit symbols allowed on attribute fields (`unit` in the category attribute schema). */
export const ATTRIBUTE_UNITS = ["mm", "cm", "m", "gsm", "kg", "g", "ml", "l", "micron", "bf", "kg/cm2", "%", "ply"] as const;

export const BIS_QCO_STATUSES = ["in-force", "rescinded", "none-found", "unverified"] as const;
export const REGULATION_KINDS = ["bis-qco", "bis-standard", "fssai", "pwm-epr", "ispm-15", "un-dg"] as const;

const key = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/, "attribute key: lowercase snake_case");
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "slug: lowercase letters, digits, hyphens");
/** HSN as stored on listings: 2 to 8 digits (same rule as catalogue `listingInputSchema`). */
export const HSN_RE = /^\d{2,8}$/;

export const PlaybookFieldSchema = z
  .object({
    key,
    label: z.string().trim().min(1).max(60),
    type: z.enum(["text", "number", "select"]),
    required: z.boolean().optional(),
    unit: z.enum(ATTRIBUTE_UNITS).optional(),
    options: z.array(z.string().trim().min(1).max(40)).min(2).optional(),
  })
  .superRefine((f, ctx) => {
    if (f.type === "select" && !f.options) ctx.addIssue({ code: "custom", message: `select field "${f.key}" needs options` });
    if (f.type !== "select" && f.options) ctx.addIssue({ code: "custom", message: `field "${f.key}" has options but is not a select` });
    if (f.options && new Set(f.options.map((o) => o.toLowerCase())).size !== f.options.length) ctx.addIssue({ code: "custom", message: `field "${f.key}" has duplicate options` });
    if (f.unit && f.type !== "number") ctx.addIssue({ code: "custom", message: `field "${f.key}": a unit only makes sense on a number field` });
  });
export type PlaybookField = z.infer<typeof PlaybookFieldSchema>;

export const RegulationSchema = z
  .object({
    kind: z.enum(REGULATION_KINDS),
    /** the standard or rule, e.g. "IS 2925:1984" or "FSSAI Packaging Regulations 2018" */
    standard: z.string().trim().min(2).max(200),
    /** only for bis-qco / bis-standard; the state of the Quality Control Order as last verified */
    qcoStatus: z.enum(BIS_QCO_STATUSES).optional(),
    /** a seller must supply a certificate / test-report reference before the listing can be approved */
    requiresCertificate: z.boolean(),
    verifiedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    note: z.string().trim().max(400).optional(),
  })
  .superRefine((r, ctx) => {
    const bis = r.kind === "bis-qco" || r.kind === "bis-standard";
    if (bis && !r.qcoStatus) ctx.addIssue({ code: "custom", message: "BIS regimes must state qcoStatus" });
    if (!bis && r.qcoStatus) ctx.addIssue({ code: "custom", message: "qcoStatus applies to BIS regimes only" });
    if (r.qcoStatus === "in-force" && !r.requiresCertificate) ctx.addIssue({ code: "custom", message: "a QCO in force must require a certificate" });
  });
export type Regulation = z.infer<typeof RegulationSchema>;

/** A hard numeric rule on an attribute (e.g. carry bags need >= 120 micron). Checked by `checkPlaybookConstraints`. */
export const ConstraintSchema = z.object({
  field: key,
  min: z.number().optional(),
  max: z.number().optional(),
  message: z.string().trim().min(5).max(200),
});
export type Constraint = z.infer<typeof ConstraintSchema>;

export const PlaybookCategorySchema = z
  .object({
    slug,
    name: z.string().trim().min(2).max(80),
    parentSlug: slug.nullish(),
    icon: z.string().trim().max(40).optional(),
    leadCap: z.number().int().min(1).max(10).optional(),
    sortOrder: z.number().int().min(0).optional(),
    /** staff-visible rationale; also the reason shown when a prohibited subcategory is chosen */
    note: z.string().trim().max(400).optional(),
    /** prohibited subcategories are rejected by moderation (ADR-003/010) */
    prohibited: z.boolean().optional(),
    attributes: z.array(PlaybookFieldSchema).default([]),
    /** attribute keys whose distinct values define a stockable variant (size, ply, ...); catalogue has no variant model yet, so this is guidance for SKU/bulk upload */
    variantAxes: z.array(key).default([]),
    units: z
      .object({
        price: z.array(z.enum(TRADE_UNITS)).min(1),
        moq: z.array(z.enum(TRADE_UNITS)).min(1),
        defaultPrice: z.enum(TRADE_UNITS),
        defaultMoq: z.enum(TRADE_UNITS),
        /** typical MOQ in `defaultMoq` units, a hint for the listing form and intent scoring */
        typicalMoq: z.number().int().min(1),
      })
      .optional(),
    /** primary HSN first; 2-8 digits */
    hsn: z.array(z.string().regex(HSN_RE, "HSN must be 2-8 digits")).default([]),
    regulations: z.array(RegulationSchema).default([]),
    constraints: z.array(ConstraintSchema).default([]),
    /** Hinglish / vernacular search aliases (transliterated), used for golden sets and search tuning */
    aliases: z.array(z.string().trim().min(2).max(60)).default([]),
  })
  .superRefine((c, ctx) => {
    const keys = c.attributes.map((a) => a.key);
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", message: `${c.slug}: duplicate attribute keys` });
    for (const v of c.variantAxes) if (!keys.includes(v)) ctx.addIssue({ code: "custom", message: `${c.slug}: variant axis "${v}" is not an attribute` });
    for (const k of c.constraints) {
      const f = c.attributes.find((a) => a.key === k.field);
      if (!f || f.type !== "number") ctx.addIssue({ code: "custom", message: `${c.slug}: constraint on "${k.field}" needs a number attribute` });
      if (k.min === undefined && k.max === undefined) ctx.addIssue({ code: "custom", message: `${c.slug}: constraint on "${k.field}" has no bound` });
    }
    if (c.units) {
      if (!c.units.price.includes(c.units.defaultPrice)) ctx.addIssue({ code: "custom", message: `${c.slug}: defaultPrice not in price units` });
      if (!c.units.moq.includes(c.units.defaultMoq)) ctx.addIssue({ code: "custom", message: `${c.slug}: defaultMoq not in moq units` });
    }
    if (c.prohibited && (c.attributes.length || c.units)) ctx.addIssue({ code: "custom", message: `${c.slug}: a prohibited category carries no schema or units` });
  });
export type PlaybookCategory = z.infer<typeof PlaybookCategorySchema>;

export const PlaybookSchema = z
  .object({
    key: slug,
    name: z.string().trim().min(2).max(120),
    /** bump when the data changes in a way that needs a re-load */
    version: z.number().int().min(1),
    /** ADR-011 status of the choice this playbook encodes; informational, loading never changes it */
    decisionStatus: z.string().trim().min(5).max(200),
    /** first = primary language for onboarding copy (ADR-004) */
    languages: z.array(z.enum(LANGS)).min(1),
    clusters: z.array(ClusterSchema).min(1),
    gates: GatesSchema.partial().optional(),
    categories: z.array(PlaybookCategorySchema).min(1),
  })
  .superRefine((p, ctx) => {
    const slugs = p.categories.map((c) => c.slug);
    if (new Set(slugs).size !== slugs.length) ctx.addIssue({ code: "custom", message: "duplicate category slugs" });
    if (new Set(p.languages).size !== p.languages.length) ctx.addIssue({ code: "custom", message: "duplicate languages" });
    for (const c of p.categories) {
      if (c.parentSlug && !slugs.includes(c.parentSlug)) ctx.addIssue({ code: "custom", message: `${c.slug}: unknown parent "${c.parentSlug}"` });
      if (c.parentSlug === c.slug) ctx.addIssue({ code: "custom", message: `${c.slug}: parent is itself` });
    }
    if (p.categories.filter((c) => !c.parentSlug).length === 0) ctx.addIssue({ code: "custom", message: "needs at least one root category" });
  });
export type Playbook = z.infer<typeof PlaybookSchema>;
export type PlaybookInput = z.input<typeof PlaybookSchema>;
