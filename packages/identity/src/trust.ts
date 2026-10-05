// Continuous trust score (ADR-003): tier × response SLA × deal/dispute outcomes × moderation flags, with inactivity decay.
export const RESPONSE_SLA_MS = 2 * 60 * 60 * 1000;
export const BADGE_THRESHOLD = 40;

export interface TrustSignals {
  tier: number; // 0..3
  /** Leads accepted within the 2h SLA / accepted after it / declined / expired unanswered. */
  acceptedFast: number;
  acceptedSlow: number;
  declined: number;
  expired: number;
  moderationRejections: number;
  dealsWon: number;
  disputesLost: number;
  /** Upheld "seller did not honour the advertised offer" reports (ADR-025). */
  offersBroken?: number;
  /** Seller-initiated lead refunds (buyer_fake / buyer_unreachable). Only an abnormal share of accepted leads costs points. */
  refundsClaimed?: number;
  /** Buyer verdicts on delivered samples (docs/design/samples.md). The approval rate counts only from SAMPLE_MIN_EVALUATED evaluated samples. */
  samplesEvaluated?: number;
  samplesApproved?: number;
  /** Sample requests that expired unanswered (48h SLA missed). */
  samplesExpired?: number;
  inactiveDays: number;
}

export const emptySignals = (tier = 0): TrustSignals => ({
  tier, acceptedFast: 0, acceptedSlow: 0, declined: 0, expired: 0, moderationRejections: 0, dealsWon: 0, disputesLost: 0, offersBroken: 0, refundsClaimed: 0, inactiveDays: 0,
});

const TIER_POINTS = [25, 40, 50, 55] as const;
const RESPONSE_MAX = 35;
// Bayesian prior (3 pseudo-leads at 70%) so one lead doesn't swing a new seller to 0 or 100.
const PRIOR_WEIGHT = 3;
const PRIOR_RATE = 0.7;
// Refund farming (security audit M2): up to 20% of accepted leads may be refunded for free (genuine fake/unreachable buyers
// exist, ADR-002); each refund beyond that costs 3 points, capped at 15. Needs a minimum sample so a new seller is not hit.
export const REFUND_FREE_SHARE = 0.2;
export const REFUND_MIN_SAMPLE = 5;
// Sample approval (docs/design/samples.md): worth at most +-SAMPLE_MAX_PTS, and only from SAMPLE_MIN_EVALUATED evaluated samples so one early
// verdict cannot move a seller. 60% approval is neutral; each 5 points of rate is worth 1 point. Unanswered requests cost 1 point each, capped.
export const SAMPLE_MIN_EVALUATED = 5;
export const SAMPLE_MAX_PTS = 5;
export const SAMPLE_EXPIRY_MAX_PENALTY = 5;

export function computeTrustScore(s: TrustSignals): { score: number; badgeActive: boolean } {
  const tierPts = TIER_POINTS[Math.min(Math.max(Math.trunc(s.tier), 0), 3)]!;
  // A decline is still a timely answer (it frees the slot for the next seller, ADR-002); slow accepts and expiries are not.
  const responded = s.acceptedFast + s.declined;
  const total = responded + s.acceptedSlow + s.expired;
  const rate = (responded + PRIOR_WEIGHT * PRIOR_RATE) / (total + PRIOR_WEIGHT);
  const responsePts = RESPONSE_MAX * rate;
  const dealPts = Math.min(10, s.dealsWon * 2);
  const disputePts = -Math.min(30, s.disputesLost * 10);
  const moderationPts = -Math.min(25, s.moderationRejections * 5);
  const offerPts = -Math.min(20, (s.offersBroken ?? 0) * 5);
  const acceptedTotal = s.acceptedFast + s.acceptedSlow;
  const excessRefunds = acceptedTotal >= REFUND_MIN_SAMPLE ? Math.max(0, (s.refundsClaimed ?? 0) - Math.floor(acceptedTotal * REFUND_FREE_SHARE)) : 0;
  const refundPts = -Math.min(15, excessRefunds * 3);
  const evaluated = s.samplesEvaluated ?? 0;
  const samplePts = evaluated >= SAMPLE_MIN_EVALUATED
    ? Math.max(-SAMPLE_MAX_PTS, Math.min(SAMPLE_MAX_PTS, Math.round(((s.samplesApproved ?? 0) / evaluated - 0.6) * 20)))
    : 0;
  const sampleExpiryPts = -Math.min(SAMPLE_EXPIRY_MAX_PENALTY, s.samplesExpired ?? 0);
  const decay = -Math.min(15, Math.max(0, Math.floor((s.inactiveDays - 30) / 10) + (s.inactiveDays > 30 ? 1 : 0)));
  const score = Math.round(Math.min(100, Math.max(0, tierPts + responsePts + dealPts + disputePts + moderationPts + offerPts + refundPts + samplePts + sampleExpiryPts + decay)));
  return { score, badgeActive: s.tier >= 1 && score >= BADGE_THRESHOLD };
}
