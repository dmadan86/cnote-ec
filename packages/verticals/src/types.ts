import { LANGS } from "@cnote/catalogue";
import { z } from "zod";

export const VERTICAL_STAGES = ["candidate", "pilot", "open", "paused"] as const;
export type VerticalStageName = (typeof VERTICAL_STAGES)[number];

export const CHECKLIST_SECTIONS = ["schema", "classifiers", "acquisition", "languages", "ops", "compliance"] as const;
export type ChecklistSection = (typeof CHECKLIST_SECTIONS)[number];

/** Allowed stage moves. candidate must pass through pilot; paused can resume at pilot or open. */
export const STAGE_TRANSITIONS: Record<VerticalStageName, readonly VerticalStageName[]> = {
  candidate: ["pilot"],
  pilot: ["open", "paused", "candidate"],
  open: ["paused"],
  paused: ["pilot", "open", "candidate"],
};

/** Stages that count as "launched": moving into one of them triggers the ADR-016 expansion rule. */
export const LAUNCHED_STAGES: readonly VerticalStageName[] = ["pilot", "open"];

export const GatesSchema = z.object({
  /** ADR-016: verified = tier >= 1 with at least one live listing in the vertical's categories */
  minVerifiedSellers: z.number().int().min(0).default(200),
  /** net adds over trailing 30 / 90 days must be >= this (default: strictly positive) */
  minNetAdds30: z.number().int().default(1),
  minNetAdds90: z.number().int().default(1),
});
export type Gates = z.infer<typeof GatesSchema>;
export const DEFAULT_GATES: Gates = GatesSchema.parse({});

export const ClusterSchema = z.object({
  /** human label, e.g. "Tiruppur knitwear" */
  label: z.string().trim().min(1).max(120),
  city: z.string().trim().min(1).max(80),
  district: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  industry: z.string().trim().min(1).max(120),
});
export type Cluster = z.infer<typeof ClusterSchema>;

export const ClassifierConfigSchema = z.object({
  /** pointers into the AI-orchestration registry (ADR-008); this package never trains or runs models */
  prohibitedModelVersion: z.string().trim().max(120).optional(),
  intentModelVersion: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(500).optional(),
});
export type ClassifierConfig = z.infer<typeof ClassifierConfigSchema>;

const slug = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "slug: lowercase letters, digits, hyphens");
const langs = z
  .array(z.enum(LANGS))
  .min(1)
  .refine((a) => new Set(a).size === a.length, "languages must be unique");

export const VerticalInputSchema = z.object({
  slug,
  name: z.string().trim().min(2).max(120),
  categorySlugs: z.array(slug).min(1).refine((a) => new Set(a).size === a.length, "category slugs must be unique"),
  languages: langs.default(["en", "hi"]),
  clusters: z.array(ClusterSchema).max(50).default([]),
  gates: GatesSchema.partial().optional(),
  classifierConfig: ClassifierConfigSchema.default({}),
  attributeSchemaSlug: slug.nullish(),
  notes: z.string().trim().max(2000).nullish(),
});
export type VerticalInput = z.input<typeof VerticalInputSchema>;

export const VerticalPatchSchema = VerticalInputSchema.omit({ slug: true }).partial();
export type VerticalPatch = z.input<typeof VerticalPatchSchema>;

export interface VerticalView {
  id: string;
  slug: string;
  name: string;
  stage: VerticalStageName;
  categorySlugs: string[];
  languages: string[];
  clusters: Cluster[];
  gates: Gates;
  classifierConfig: ClassifierConfig;
  attributeSchemaSlug: string | null;
  notes: string | null;
  stageChangedAt: string;
  createdAt: string;
}

export interface ChecklistItemView {
  id: string;
  verticalId: string;
  section: ChecklistSection;
  title: string;
  done: boolean;
  owner: string | null;
  evidenceUrl: string | null;
  doneAt: string | null;
  sortOrder: number;
}

export interface StageChangeView {
  id: string;
  verticalId: string;
  from: VerticalStageName;
  to: VerticalStageName;
  changedBy: string;
  overridden: boolean;
  overrideReason: string | null;
  gateSnapshot: unknown;
  createdAt: string;
}

export interface GateResult {
  verticalId: string;
  slug: string;
  verifiedSellers: number;
  /** null when there is no earlier snapshot to compare against (insufficient history) */
  netAdds30: number | null;
  netAdds90: number | null;
  /** age in days of the baseline snapshot actually used (may be shorter than the window early on) */
  baselineDays30: number | null;
  baselineDays90: number | null;
  thresholds: Gates;
  checks: { verifiedSellers: boolean; netAdds30: boolean; netAdds90: boolean };
  meetsGates: boolean;
  evaluatedAt: string;
}
