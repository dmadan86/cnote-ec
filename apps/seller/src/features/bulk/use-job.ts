"use client";
import { useEffect, useState } from "react";
import type { BulkJobView } from "@cnote/bulk";

/** Polls one job while it is doing work (every 2 s), stopping when it settles. */
export function useJob(initial: BulkJobView | null): [BulkJobView | null, (j: BulkJobView | null) => void] {
  const [job, setJob] = useState(initial);
  const id = job?.id;
  const active = !!job && (job.active || job.status === "uploaded");
  useEffect(() => {
    if (!id || !active) return;
    let stopped = false;
    const t = setInterval(async () => {
      try {
        const r = await fetch(`/api/bulk/jobs/${id}`, { cache: "no-store" });
        const body = (await r.json()) as { job?: BulkJobView };
        if (!stopped && body.job) setJob(body.job);
      } catch {
        /* keep polling; transient network error */
      }
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [id, active]);
  return [job, setJob];
}
