// @cnote/metrics public contract: ADR success metrics computed daily from the DomainEvent log.
export { METRICS, METRIC_BY_ID, getDefinition, meetsTarget } from "./definitions";
export type { MetricDefinition, MetricKind, MetricTarget, MetricUnit, MetricAlertRule } from "./definitions";
export {
  backfill,
  computeDay,
  computeMetric,
  countOpenAlerts,
  getDimensionBreakdown,
  getMetricSeries,
  getScorecard,
  listAlerts,
  resolveAlert,
} from "./compute";
export type { AlertView, ComputeResult, DimensionRow, MetricRow, ScoreStatus, ScorecardRow, SeriesPoint } from "./compute";
export { addDays, dayBounds, istDay } from "./time";
export { worker } from "./jobs";
