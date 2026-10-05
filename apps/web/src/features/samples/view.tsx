import { Badge, type BadgeTone } from "@cnote/ui";
import { Check, Circle, CircleDot } from "lucide-react";
import type { SampleStatus, SampleView } from "@/lib/samples";
import { formatDate, type Locale } from "@/i18n/config";
import { fill, type SampleLabels } from "./labels";

const TONE: Record<SampleStatus, BadgeTone> = {
  requested: "warning", accepted: "brand", declined: "danger", dispatched: "brand", delivered: "warning", approved: "success", rejected: "danger", expired: "neutral", cancelled: "neutral",
};

/** Status chip: the word is always present (colour is never the only signal). */
export const SampleStatusBadge = ({ status, labels }: { status: SampleStatus; labels: SampleLabels }) => (
  <Badge tone={TONE[status]}>{labels[`status_${status}` as keyof SampleLabels]}</Badge>
);

const STEPS = ["requested", "accepted", "dispatched", "delivered", "evaluated"] as const;
type Step = (typeof STEPS)[number];
const ICON = { done: Check, current: CircleDot, upcoming: Circle } as const;
const REACHED: Record<SampleStatus, number> = { requested: 0, accepted: 1, declined: 0, dispatched: 2, delivered: 3, approved: 5, rejected: 5, expired: 0, cancelled: 0 };

/**
 * Order-tracking style progress (H&M numbered steps, docs/design/samples.md): an ordered list whose done / now / next state is written
 * out, aria-current on the current step; ended requests (declined, expired, cancelled) show what happened instead of a dead tracker.
 */
export function SampleProgress({ sample, labels: l, locale }: { sample: SampleView; labels: SampleLabels; locale: Locale }) {
  const reached = REACHED[sample.status];
  const ended = sample.status === "declined" || sample.status === "expired" || sample.status === "cancelled";
  const stateOf = (i: number): "done" | "current" | "upcoming" => (ended ? (i === 0 ? "done" : "upcoming") : i < reached ? "done" : i === reached ? "current" : "upcoming");
  const dt = (iso: string) => formatDate(new Date(iso), locale, { dateStyle: "medium", timeStyle: "short" });
  return (
    <div className="flex flex-col gap-4">
      <ol aria-label={l.stepsLabel} className="grid gap-3 sm:grid-cols-5">
        {STEPS.map((step: Step, i) => {
          const state = stateOf(i);
          const Icon = ICON[state];
          return (
            <li key={step} aria-current={state === "current" ? "step" : undefined} className="flex items-start gap-2 text-sm">
              <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                <span className="font-medium text-ink">{l[`step_${step}` as keyof SampleLabels]}</span>
                <br />
                <span className="text-xs text-muted">{state === "done" ? l.stateDone : state === "current" ? l.stateCurrent : l.stateUpcoming}</span>
              </span>
            </li>
          );
        })}
      </ol>
      {ended ? <p className="text-sm font-medium text-ink">{fill(l.ended, { status: l[`status_${sample.status}` as keyof SampleLabels] })}</p> : null}
      <div>
        <h3 className="text-sm font-semibold text-ink">{l.history}</h3>
        <ol className="mt-2 flex flex-col gap-2">
          {sample.timeline.map((e, i) => (
            <li key={`${e.status}-${i}`} className="rounded-md border border-line p-2 text-sm">
              <span className="font-medium text-ink">{l[`status_${e.status}` as keyof SampleLabels]}</span>
              <span className="text-muted"> · <time dateTime={e.at}>{dt(e.at)}</time></span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
