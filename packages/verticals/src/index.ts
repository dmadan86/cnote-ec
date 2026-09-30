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
