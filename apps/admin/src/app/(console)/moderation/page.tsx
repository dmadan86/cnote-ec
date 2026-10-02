import { hasPrivilege } from "@cnote/admin";
import { getListingsByIds } from "@cnote/catalogue";
import { getTrustProfiles } from "@cnote/identity";
import { type ModerationItem, type UgcKind, listModerationQueue } from "@cnote/reviews";
import { Alert, Badge, Card, CardBody, EmptyState, LinkTabs, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { Mono } from "@/components/table";
import { DecisionForm } from "@/features/moderation/decision-form";
import { requireStaff } from "@/lib/auth";
import { fmtDate, one, safe } from "@/lib/util";

export const metadata = { title: "Moderation" };

const KINDS: { kind: UgcKind; label: string }[] = [
  { kind: "review", label: "Reviews" },
  { kind: "comment", label: "Comments" },
  { kind: "reply", label: "Seller replies" },
  { kind: "question", label: "Product questions" },
  { kind: "answer", label: "Product answers" },
];
const STATUSES = [
  { value: undefined, label: "All open" },
  { value: "pending", label: "Pending" },
  { value: "flagged", label: "Flagged" },
] as const;

const href = (kind: UgcKind, status?: string, cursor?: string) => {
  const q = new URLSearchParams({ kind });
  if (status) q.set("status", status);
  if (cursor) q.set("cursor", cursor);
  return `/moderation?${q}`;
};

function Stars({ rating }: { rating: number }) {
  return (
    <span role="img" aria-label={`${rating} out of 5 stars`} className="text-accent-500">
      {"★".repeat(rating)}<span className="text-line">{"★".repeat(5 - rating)}</span>
    </span>
  );
}

const verdictTone = { allow: "success", review: "warning", block: "danger" } as const;

export default async function ModerationPage({ searchParams }: PageProps<"/moderation">) {
  const sp = await searchParams;
  const kind = KINDS.find((k) => k.kind === one(sp.kind))?.kind ?? "review";
  const status = one(sp.status) === "pending" || one(sp.status) === "flagged" ? (one(sp.status) as "pending" | "flagged") : undefined;
  const cursor = one(sp.cursor);
  const query = `/moderation?kind=${kind}${status ? `&status=${status}` : ""}`;
  const { staff } = await requireStaff(query, "ugc.read");
  const canModerate = hasPrivilege(staff, "ugc.moderate");

  const queue = await safe("reviews.listModerationQueue", () => listModerationQueue({ kind, status, cursor }));
  const items = queue?.items ?? [];
  const listings = await safe("catalogue.getListingsByIds", () => getListingsByIds([...new Set(items.map((i) => i.listingId))]));
  const titles = new Map((listings ?? []).map((l) => [l.id, l.title]));
  const profiles = await safe("identity.getTrustProfiles", () => getTrustProfiles(items.flatMap((i) => (i.authorBusinessId ? [i.authorBusinessId] : []))));

  return (
    <>
      <PageHeader title="Moderation" description="Reviews, comments and replies are held until a staff member approves them. Product questions and answers are pre-screened by AI; flagged and reported ones land here. Oldest first." />
      <LinkTabs label="Content type" items={KINDS.map((k) => ({ href: href(k.kind, status), label: k.label, active: k.kind === kind }))} />
      <LinkTabs label="Status" variant="underline" items={STATUSES.map((s) => ({ href: href(kind, s.value), label: s.label, active: s.value === status }))} />
      {!canModerate ? <Alert tone="info">You can view the queue but your role can&apos;t approve or reject content.</Alert> : null}
      {queue === null ? <Alert tone="warning">The moderation queue is currently unavailable.</Alert> : null}
      {queue && items.length === 0 ? <EmptyState title="Nothing waiting" description="No content in this view needs a decision." /> : null}
      <ul className="space-y-3">
        {items.map((i: ModerationItem) => {
          const author = i.authorBusinessId ? profiles?.get(i.authorBusinessId)?.name : undefined;
          return (
            <li key={`${i.kind}-${i.id}`}>
              <Card>
                <CardBody className="grid gap-4 lg:grid-cols-[1fr_20rem]">
                  <div className="min-w-0 space-y-2 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{titles.get(i.listingId) ?? <Mono>{i.listingId.slice(0, 8)}</Mono>}</span>
                      {i.rating != null && i.kind === "review" ? <Stars rating={i.rating} /> : null}
                      <Badge tone={i.status === "flagged" ? "warning" : "neutral"}>{i.status}</Badge>
                      {i.aiVerdict ? <Badge tone={verdictTone[i.aiVerdict as keyof typeof verdictTone] ?? "neutral"}>AI: {i.aiVerdict}</Badge> : null}
                      {i.reportCount > 0 ? <Badge tone="danger">{i.reportCount} report{i.reportCount === 1 ? "" : "s"}</Badge> : null}
                      {i.isSeller && (i.kind === "comment" || i.kind === "answer") ? <Badge tone="brand">Seller</Badge> : null}
                    </div>
                    {i.title ? <p className="font-medium">{i.title}</p> : null}
                    <p className="whitespace-pre-wrap">{i.body}</p>
                    {i.context ? (
                      <p className="border-l-2 border-line pl-3 text-muted">
                        {i.kind === "reply" ? "Replying to review: " : i.kind === "answer" ? "Answering question: " : "Replying to: "}
                        {i.context.slice(0, 300)}
                      </p>
                    ) : null}
                    <p className="text-xs text-muted">
                      {author ?? (i.kind === "reply" || i.kind === "answer" ? "Seller" : "Unknown author")} · {fmtDate(i.createdAt)}
                      {i.moderationNote ? ` · previous note: ${i.moderationNote}` : ""}
                    </p>
                  </div>
                  {canModerate ? <DecisionForm kind={i.kind} id={i.id} /> : null}
                </CardBody>
              </Card>
            </li>
          );
        })}
      </ul>
      {queue?.nextCursor ? <Link href={href(kind, status, queue.nextCursor)} className="text-sm font-medium text-brand-700 hover:underline">Next page →</Link> : null}
    </>
  );
}
