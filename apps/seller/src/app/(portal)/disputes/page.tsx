import type { Metadata } from "next";
import Link from "next/link";
import { actorOf } from "@cnote/next-kit";
import { disputesEnabled, listDisputes } from "@/lib/disputes";
import { Alert, Badge, Card, CardBody, EmptyState, PageHeader, Money, type BadgeTone } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { load } from "@/lib/safe";

export const metadata: Metadata = { title: "Disputes" };
export const dynamic = "force-dynamic";
const TONE: Record<string, BadgeTone> = { resolved: "success", withdrawn: "neutral", awaiting_adjudication: "warning", auto_resolved: "warning" };
const label = (s: string) => s.replace(/_/g, " ");

export default async function DisputesPage() {
  const session = await requireSeller("/disputes");
  if (!disputesEnabled()) return <div className="space-y-6"><PageHeader title="Disputes" /><Alert tone="info">Dispute resolution is not available yet.</Alert></div>;
  const res = await load(() => listDisputes(actorOf(session)));
  if (!res.ok) return <div className="space-y-6"><PageHeader title="Disputes" /><Alert tone="danger">{res.error}</Alert></div>;
  return (
    <div className="space-y-6">
      <PageHeader title="Disputes" description="Problems reported on your orders. Respond within 72 hours with your side and any evidence." />
      {res.data.length === 0 ? <EmptyState title="No disputes" description="Nothing has been reported on your orders." /> : (
        <ul className="grid gap-3">
          {res.data.map((d) => (
            <li key={d.id}>
              <Link href={`/disputes/${d.id}`} className="block rounded-card focus-visible:outline-2 focus-visible:outline-brand-600">
                <Card className="transition-colors hover:border-brand-600">
                  <CardBody className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold capitalize text-ink">{label(d.type)}</p>
                      <p className="mt-0.5 text-xs text-muted">{d.openedByMe ? "You opened this" : "Reported by the buyer"} · {formatDate(d.createdAt)} · due {formatDate(d.dueAt)}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      {d.amountPaise !== null ? <Money paise={d.amountPaise} /> : null}
                      {d.needsMyAction ? <Badge tone="danger">Action needed</Badge> : null}
                      <Badge tone={TONE[d.status] ?? "brand"}>{label(d.status)}</Badge>
                    </div>
                  </CardBody>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
