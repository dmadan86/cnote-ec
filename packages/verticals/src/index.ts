// @cnote/verticals: ADR-016 vertical expansion playbook and gates.
// PUBLIC CONTRACT.
export * from "./types";
export { setVerticalStatsPort, getVerticalStatsPort, defaultStatsPort, expandCategorySlugs, type VerticalStatsPort } from "./stats";
export { evaluateVerticalGates, blockingVerticals, snapshotVertical, snapshotAllVerticals, listSnapshots, VERIFIED_MIN_TIER } from "./gates";
export {
  listOpenVerticals, getVerticalForCategory, listVerticals, getVertical, getVerticalBySlug, createVertical, updateVertical,
  listChecklist, addChecklistItem, updateChecklistItem, deleteChecklistItem, checklistProgress, changeStage, listStageChanges,
  type ChangeStageInput, type ChangeStageResult,
} from "./verticals";
export { PLAYBOOK_TEMPLATE, createVerticalFromTemplate, listCandidateRoots } from "./template";
export { worker } from "./worker";
// Vertical playbooks as inert data (ADR-011/016). Activation is explicit via loadPlaybook.
export {
  PLAYBOOKS, PACKAGING_BENGALURU, listPlaybooks, getPlaybook, loadPlaybook, playbookToCategoryDefs, playbookToEvalCategories, regulationsFor,
  categoryNeedsCertificate, checkPlaybookConstraints, playbookRequiresCertificate, CERTIFICATE_FIELD, PlaybookSchema, TRADE_UNITS, ATTRIBUTE_UNITS, HSN_RE,
  type Playbook, type PlaybookCategory, type PlaybookField, type Regulation, type LoadPlaybookResult,
} from "./playbook";
