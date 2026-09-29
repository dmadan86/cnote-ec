import { prisma } from "@cnote/db";

export interface FunnelRow {
  /** IST calendar day, YYYY-MM-DD */
  day: string;
  trigger: string;
  started: number;
  otpSent: number;
  verified: number;
  converted: number;
  abandoned: number;
}

/**
 * Funnel counts by trigger and IST day (counts only, no phone data). Each stage is cumulative: `otpSent` counts
 * every capture that reached the OTP step (a phone hash was recorded), including ones that later verified.
 */
export async function funnelByTriggerDay(from: Date, to: Date): Promise<FunnelRow[]> {
  const rows = await prisma.$queryRaw<{ day: string; trigger: string; started: bigint; otp_sent: bigint; verified: bigint; converted: bigint; abandoned: bigint }[]>`
    SELECT to_char((created_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day,
           trigger,
           count(*) AS started,
           count(*) FILTER (WHERE phone_hash IS NOT NULL OR status IN ('otp_sent','verified','converted')) AS otp_sent,
           count(*) FILTER (WHERE status IN ('verified','converted')) AS verified,
           count(*) FILTER (WHERE status = 'converted') AS converted,
           count(*) FILTER (WHERE status = 'abandoned') AS abandoned
    FROM lead_captures
    WHERE created_at >= ${from} AND created_at < ${to}
    GROUP BY 1, 2
    ORDER BY 1 DESC, 2`;
  return rows.map((r) => ({
    day: r.day, trigger: r.trigger, started: Number(r.started), otpSent: Number(r.otp_sent),
    verified: Number(r.verified), converted: Number(r.converted), abandoned: Number(r.abandoned),
  }));
}
