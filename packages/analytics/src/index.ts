// @cnote/analytics public contract (ADR-023): CDC-style read models projected from the domain event log.
//   daily funnel facts, GMV by category/state, seller cohort facts; idempotent, resumable (checkpoint per projection),
//   backfill/reset from event 0. Read models are disposable; the event log stays the source of truth (ADR-007).
export { worker, projectTick, PROJECT_EVERY_MS } from "./jobs";
export { runProjection, runProjections, backfill, getProjectionStatus, orderProjections, withDependents } from "./runner";
export type { RunOptions, RunResult, ProjectionStatus } from "./runner";
export { PROJECTIONS, refsProjection, funnelProjection, gmvProjection, sellerCohortProjection, setBusinessStateResolver } from "./projections";
export type { BusinessStateResolver } from "./projections";
export type { Projection } from "./types";
export { getFunnelDaily, getGmvDaily, getSellerCohorts } from "./queries";
export type { FunnelRow, GmvRow, CohortRow } from "./queries";
export { istDate, istMonth } from "./time";
