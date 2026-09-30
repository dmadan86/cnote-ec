import type { Prisma } from "@cnote/db";
import { ClassifierConfigSchema, ClusterSchema, DEFAULT_GATES, GatesSchema, type ChecklistItemView, type ChecklistSection, type StageChangeView, type VerticalStageName, type VerticalView } from "./types";
import { z } from "zod";

type VerticalRow = Prisma.VerticalGetPayload<object>;
type ItemRow = Prisma.VerticalChecklistItemGetPayload<object>;
type ChangeRow = Prisma.VerticalStageChangeGetPayload<object>;

export const toVerticalView = (r: VerticalRow): VerticalView => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  stage: r.stage as VerticalStageName,
  categorySlugs: r.categorySlugs,
  languages: r.languages,
  clusters: z.array(ClusterSchema).catch([]).parse(r.clusters),
  gates: GatesSchema.catch(DEFAULT_GATES).parse({ ...DEFAULT_GATES, ...(r.gates as object) }),
  classifierConfig: ClassifierConfigSchema.catch({}).parse(r.classifierConfig),
  attributeSchemaSlug: r.attributeSchemaSlug,
  notes: r.notes,
  stageChangedAt: r.stageChangedAt.toISOString(),
  createdAt: r.createdAt.toISOString(),
});

export const toItemView = (r: ItemRow): ChecklistItemView => ({
  id: r.id,
  verticalId: r.verticalId,
  section: r.section as ChecklistSection,
  title: r.title,
  done: r.done,
  owner: r.owner,
  evidenceUrl: r.evidenceUrl,
  doneAt: r.doneAt?.toISOString() ?? null,
  sortOrder: r.sortOrder,
});

export const toChangeView = (r: ChangeRow): StageChangeView => ({
  id: r.id,
  verticalId: r.verticalId,
  from: r.fromStage as VerticalStageName,
  to: r.toStage as VerticalStageName,
  changedBy: r.changedBy,
  overridden: r.overridden,
  overrideReason: r.overrideReason,
  gateSnapshot: r.gateSnapshot,
  createdAt: r.createdAt.toISOString(),
});
