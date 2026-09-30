// Turns a MetricSpec into one aggregate query over domain_events. All interpolated text comes from
// the constant registry in definitions.ts (never user input); day bounds are bound parameters.
// Note: domain_events has no (type, occurred_at) index yet; every query still bounds occurred_at so
// it benefits as soon as one is added (see docs/design/metrics.md).
import type { MetricSpec } from "./definitions";

export interface AggRow {
  dim: string;
  num: number | null;
  den: number | null;
  val: number | null;
}

const list = (types: string[]) => types.map((t) => `'${t.replace(/'/g, "''")}'`).join(", ");
const DIM = "CASE WHEN GROUPING(cat) = 1 THEN '' ELSE 'category:' || COALESCE(cat, 'none') END";

/** Returns SQL with $1 = day start, $2 = day end (timestamptz). */
export function buildSql(spec: MetricSpec): string {
  // explicit casts: Postgres cannot infer a type for a parameter that is only used in `$1 - interval`
  // or not at all in a given query shape
  return specSql(spec).replaceAll("$1", "$1::timestamptz").replaceAll("$2", "$2::timestamptz");
}

function specSql(spec: MetricSpec): string {
  switch (spec.mode) {
    case "count":
      return `SELECT ''::text AS dim, count(*)::float8 AS num, NULL::float8 AS den, NULL::float8 AS val
              FROM domain_events WHERE type IN (${list(spec.types)}) AND occurred_at >= $1 AND occurred_at < $2`;
    case "median_response":
      return `SELECT ''::text AS dim, NULL::float8 AS num, count(*)::float8 AS den,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY (payload->>'responseMs')::float8 / 60000.0)::float8 AS val
              FROM domain_events
              WHERE type = 'LeadAccepted' AND occurred_at >= $1 AND occurred_at < $2 AND payload->>'responseMs' IS NOT NULL`;
    case "snapshot_t1":
      return `WITH sellers AS (
                SELECT DISTINCT payload->>'businessId' AS b FROM domain_events
                WHERE type = 'BusinessCreated' AND (payload->>'isSeller')::boolean AND occurred_at < $2 AND $1 IS NOT NULL),
              t1 AS (
                SELECT DISTINCT payload->>'businessId' AS b FROM domain_events
                WHERE type = 'BusinessVerified' AND (payload->>'tier')::int >= 1 AND occurred_at < $2)
              SELECT ''::text AS dim, count(t1.b)::float8 AS num, count(*)::float8 AS den, NULL::float8 AS val
              FROM sellers LEFT JOIN t1 USING (b)`;
    case "cohort":
      return cohortSql(spec);
  }
}

function cohortSql(spec: Extract<MetricSpec, { mode: "cohort" }>): string {
  const { cohort, follow } = spec;
  const hasCat = spec.categoryViaEnquiry || spec.categoryOwn;
  const flag = cohort.flag ?? "false";
  const cohortCte = `cohort AS (
      SELECT DISTINCT ON (${cohort.key}) ${cohort.key} AS k, occurred_at AS at,
             payload->>'enquiryId' AS enq, ${spec.categoryOwn ? "payload->>'categoryId'" : "NULL::text"} AS own_cat, (${flag}) AS flag
      FROM domain_events
      WHERE type IN (${list(cohort.types)}) AND occurred_at >= $1 AND occurred_at < $2 ${cohort.where ? `AND (${cohort.where})` : ""}
      ORDER BY ${cohort.key}, id ${cohort.latest ? "DESC" : "ASC"})`;
  const catCte = spec.categoryViaEnquiry
    ? `, cat AS (
      SELECT DISTINCT ON (payload->>'enquiryId') payload->>'enquiryId' AS enq, payload->>'categoryId' AS cat
      FROM domain_events
      WHERE type = 'EnquiryCreated' AND occurred_at >= $1 - interval '60 days' AND occurred_at < $2
      ORDER BY payload->>'enquiryId', id)`
    : "";
  const followCte = follow
    ? `, follow AS (
      SELECT ${follow.key} AS k, min(occurred_at) AS first_at, count(*) AS n
      FROM domain_events
      WHERE type IN (${list(follow.types)}) AND occurred_at >= $1 AND occurred_at < $2 + interval '__W__ days' ${follow.where ? `AND (${follow.where})` : ""}
      GROUP BY 1)`
    : "";
  const catExpr = spec.categoryViaEnquiry ? "cat.cat" : spec.categoryOwn ? "c.own_cat" : "NULL::text";
  const joined = `, joined AS (
      SELECT c.k, c.flag, ${catExpr} AS cat,
             ${follow ? `(f.first_at IS NOT NULL AND f.first_at >= c.at AND f.first_at < c.at + interval '__W__ days')` : "false"} AS hit,
             ${follow ? `CASE WHEN f.first_at IS NOT NULL THEN extract(epoch FROM f.first_at - c.at) / 60.0 END` : "NULL::float8"} AS mins,
             ${follow ? "COALESCE(f.n, 0)" : "0"} AS n
      FROM cohort c
      ${follow ? "LEFT JOIN follow f ON f.k = c.k" : ""}
      ${spec.categoryViaEnquiry ? "LEFT JOIN cat ON cat.enq = c.enq" : ""})`;
  let agg: string;
  if (spec.medianMinutes) {
    agg = `NULL::float8 AS num, count(*) FILTER (WHERE hit)::float8 AS den,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY mins) FILTER (WHERE hit)::float8 AS val`;
  } else if (follow?.count) {
    agg = `sum(n)::float8 AS num, count(*)::float8 AS den, NULL::float8 AS val`;
  } else if (follow) {
    agg = `count(*) FILTER (WHERE hit)::float8 AS num, count(*)::float8 AS den, NULL::float8 AS val`;
  } else {
    agg = `count(*) FILTER (WHERE flag)::float8 AS num, count(*)::float8 AS den, NULL::float8 AS val`;
  }
  const grouping = hasCat ? `GROUP BY GROUPING SETS ((), (cat))` : "";
  const dim = hasCat ? DIM : "''::text";
  return `WITH ${cohortCte}${catCte}${followCte}${joined}
    SELECT ${dim} AS dim, ${agg} FROM joined ${grouping}`;
}

/** Substitute the follow-up window (days) into a built cohort query. */
export function withWindow(sql: string, windowDays: number): string {
  return sql.replaceAll("__W__", String(Math.max(0, Math.floor(windowDays))));
}
