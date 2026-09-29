import type { Metadata } from "next";
import Link from "next/link";
import { Alert, Badge, Card, CardBody, EmptyState, LinkTabs, PageHeader } from "@cnote/ui";
import { listSellerUgc, type SellerUgcItem, type UgcStatus } from "@cnote/reviews";
import { ReplyForm } from "@/features/reviews/reply-form";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { catalogue } from "@/lib/services";

export const metadata: Metadata = { title: "Reviews & questions" };

const replyTone: Record<UgcStatus, { tone: "neutral" | "warning" | "success" | "danger"; label: string }> = {
  pending: { tone: "neutral", label: "Awaiting approval" },
  flagged: { tone: "neutral", label: "Awaiting approval" },
  approved: { tone: "success", label: "Published" },
  rejected: { tone: "danger", label: "Not approved" },
};

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function Stars({ rating }: { rating: number }) {
  return (
    <span role="img" aria-label={`${rating} out of 5 stars`} className="text-accent-500">
      {"★".repeat(rating)}<span className="text-line">{"★".repeat(5 - rating)}</span>
    </span>
  );
}

export default async function ReviewsPage({ searchParams }: PageProps<"/reviews">) {
  const sp = await searchParams;
  const kind = first(sp.kind) === "comment" ? "comment" : "review";
  const needsReply = first(sp.filter) === "unanswered";
  const cursor = first(sp.cursor);
  const session = await requireSeller("/reviews");

  const [ugc, listings] = await Promise.all([
    load(() => listSellerUgc(session.business.id, { kind, needsReply, cursor })),
    load(() => catalogue.listSellerListings(session.business.id)),
  ]);
  const titles = new Map(listings.ok ? listings.data.map((l) => [l.id, l.title]) : []);
  const href = (k: string, f?: string, c?: string) => `/reviews?kind=${k}${f ? `&filter=${f}` : ""}${c ? `&cursor=${c}` : ""}`;

  return (
    <div className="space-y-6">
      <PageHeader title="Reviews & questions" description="Buyers' feedback on your products. Everything, including your replies, is checked by our team before it goes public." />
      <LinkTabs label="Type" items={[
        { href: href("review", needsReply ? "unanswered" : undefined), label: "Reviews", active: kind === "review" },
        { href: href("comment", needsReply ? "unanswered" : undefined), label: "Questions", active: kind === "comment" },
      ]} />
      <LinkTabs label="Filter" variant="underline" items={[
        { href: href(kind), label: "All", active: !needsReply },
        { href: href(kind, "unanswered"), label: "Needs a reply", active: needsReply },
      ]} />
      {!ugc.ok ? <Alert tone="danger">{ugc.error}</Alert> : ugc.data.items.length === 0 ? (
        <EmptyState title={needsReply ? "Nothing waiting for your reply" : kind === "review" ? "No published reviews yet" : "No questions yet"} description="New reviews and questions appear here once our team has approved them." />
      ) : (
        <ul className="grid gap-4">
          {ugc.data.items.map((i: SellerUgcItem) => (
            <li key={`${i.kind}-${i.id}`}>
              <Card>
                <CardBody className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Link href={`/listings/${i.listingId}/edit`} className="font-semibold text-brand-700 hover:underline">{titles.get(i.listingId) ?? "Product"}</Link>
                    {i.rating != null ? <Stars rating={i.rating} /> : null}
                    {i.needsReply ? <Badge tone="warning">Needs a reply</Badge> : null}
                  </div>
                  {i.title ? <p className="font-medium text-ink">{i.title}</p> : null}
                  <p className="whitespace-pre-wrap text-sm text-ink">{i.body}</p>
                  <p className="text-xs text-muted">{i.authorName} · {new Date(i.createdAt).toLocaleDateString("en-IN", { dateStyle: "medium" })}</p>
                  {i.reply ? (
                    <div className="space-y-1 rounded-lg bg-canvas p-3 text-sm">
                      <p className="flex flex-wrap items-center gap-2 font-medium">Your reply <Badge tone={replyTone[i.reply.status].tone}>{replyTone[i.reply.status].label}</Badge></p>
                      <p className="whitespace-pre-wrap">{i.reply.body}</p>
                      {i.reply.moderationNote ? <p className="text-danger">Reason: {i.reply.moderationNote}</p> : null}
                    </div>
                  ) : null}
                  {i.kind === "review" || !i.reply || i.reply.status === "rejected" ? <ReplyForm id={i.id} kind={i.kind} existing={i.kind === "review" && !!i.reply} /> : null}
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {ugc.ok && ugc.data.nextCursor ? <Link href={href(kind, needsReply ? "unanswered" : undefined, ugc.data.nextCursor)} className="text-sm font-medium text-brand-700 hover:underline">Next page →</Link> : null}
    </div>
  );
}
