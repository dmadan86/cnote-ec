import { getDraft, getStorefront } from "@cnote/storefront";
import { Alert, Badge, buttonClasses, Card, CardBody, Container, PageHeader } from "@cnote/ui";
import { ExternalLink, LayoutTemplate, Pencil } from "lucide-react";
import Link from "next/link";
import { createStorefrontAction } from "@/features/studio/actions";
import { requireSellerSession } from "@/lib/auth";
import { storeUrl } from "@/lib/env";

export const metadata = { title: "Overview" };

const STATUS = { draft: ["neutral", "Not published"], live: ["success", "Live"], suspended: ["danger", "Suspended"] } as const;

export default async function Overview() {
  const session = await requireSellerSession("/");
  const biz = session.business!;
  const sf = await getStorefront(biz.id);
  if (!sf) {
    return (
      <Container className="max-w-3xl py-12">
        <PageHeader title="Build your storefront" description="A branded mini-site for your business, with your real products, live verification and buyer reviews. Pick a template, make it yours, publish in minutes." />
        <Card className="mt-6"><CardBody className="flex flex-col items-start gap-4 p-6">
          <p className="text-sm text-ink">Your address will be suggested from your business name; you can change it any time.</p>
          <form action={createStorefrontAction}><button type="submit" className={buttonClasses("primary", "lg")}><LayoutTemplate className="size-4" aria-hidden /> Get started</button></form>
        </CardBody></Card>
      </Container>
    );
  }
  const d = await getDraft(biz.id, session.personId);
  const [tone, label] = STATUS[sf.status];
  return (
    <Container className="max-w-4xl space-y-6 py-8">
      <PageHeader title="Your storefront" description="Edit, preview and publish your mini-site." actions={<Link href="/editor" className={buttonClasses("primary")}><Pencil className="size-4" aria-hidden /> Open editor</Link>} />
      {sf.status === "suspended" ? <Alert tone="danger">This storefront is suspended{sf.suspendedReason ? `: ${sf.suspendedReason}` : ""}. Contact support to have it reviewed.</Alert> : null}
      {d.pendingReview ? <Alert tone="info">Your latest version is with our review team because automated checks flagged some content. Nothing has gone live from it yet. You can keep editing meanwhile.</Alert> : null}
      {d.lastRejection ? <Alert tone="warning">Your last submission was not approved{d.lastRejection.note ? `: ${d.lastRejection.note}` : "."} Edit the flagged content and publish again.</Alert> : null}
      <Card><CardBody className="grid gap-4 p-6 sm:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Status</p>
          <p className="mt-1 flex items-center gap-2"><Badge tone={tone}>{label}</Badge>{d.hasUnpublishedChanges && sf.status === "live" ? <Badge tone="warning">Unpublished changes</Badge> : null}</p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Address</p>
          <p className="mt-1 break-all text-sm text-ink">{storeUrl(sf.slug)}</p>
          {sf.status === "live" ? <a href={storeUrl(sf.slug)} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline">View live storefront <ExternalLink className="size-3.5" aria-hidden /><span className="sr-only">(opens in a new tab)</span></a> : null}
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Template</p>
          <p className="mt-1 text-sm text-ink">{sf.templateKey ?? "None applied yet"}</p>
          <Link href="/templates" className="mt-1 inline-block text-sm font-medium text-brand-700 hover:underline">Browse templates</Link>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Verification and reviews</p>
          <p className="mt-1 text-sm text-muted">Shown automatically from your platform profile. They cannot be edited, and they update on their own.</p>
        </div>
      </CardBody></Card>
    </Container>
  );
}
