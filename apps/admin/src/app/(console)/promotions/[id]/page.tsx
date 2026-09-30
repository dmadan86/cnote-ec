import { hasPrivilege } from "@cnote/admin";
import { getPromotion, previewPromotion } from "@cnote/promotions";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, PageHeader } from "@cnote/ui";
import { notFound } from "next/navigation";
import { PromotionEditor, type EditorValue } from "@/features/promotions/editor";
import { PromotionWorkflow } from "@/features/promotions/workflow";
import { requireStaff } from "@/lib/auth";
import { fmtDate, safe } from "@/lib/util";

export const metadata = { title: "Promotion" };
const istInput = (iso: string) => new Date(new Date(iso).getTime() + 5.5 * 3_600_000).toISOString().slice(0, 16);

export default async function PromotionPage({ params }: PageProps<"/promotions/[id]">) {
  const { id } = await params;
  const { staff } = await requireStaff(`/promotions/${id}`, "promotions.read");
  const p = await safe("promotions.get", () => getPromotion(id));
  if (!p) notFound();
  const canManage = hasPrivilege(staff, "promotions.manage");
  const canPublish = hasPrivilege(staff, "promotions.publish");
  const editable = canManage && (p.status === "draft" || p.status === "in_review");
  const previews = await Promise.all(["en", "hi"].map(async (l) => [l, await safe("promotions.preview", () => previewPromotion(id, l))] as const));
  const value: EditorValue = {
    id: p.id, kind: p.kind, template: p.template, internalName: p.internalName, surfaces: p.surfaces, priority: p.priority, startsAt: istInput(p.startsAt), endsAt: istInput(p.endsAt),
    segment: p.audience.segment, states: (p.audience.states ?? []).join(", "), languages: p.audience.languages ?? [],
    items: p.items.map((i) => `${i.listingId ? `listing:${i.listingId}` : i.categoryId ? `category:${i.categoryId}` : `business:${i.businessId}`} | ${i.editorNote ?? ""}`).join("\n"),
    contents: Object.fromEntries(p.contents.map((c) => [c.locale, c])),
  };
  return (
    <>
      <PageHeader title={p.internalName} description={`${p.kind.replace("_", " ")} · ${p.surfaces.join(", ")} · ${fmtDate(p.startsAt)} to ${fmtDate(p.endsAt)} (IST)`} actions={<Badge tone={p.status === "approved" ? "success" : p.status === "in_review" ? "warning" : "neutral"}>{p.status.replace("_", " ")}</Badge>} />
      <PromotionWorkflow id={p.id} status={p.status} canManage={canManage} canPublish={canPublish} isAuthor={p.createdBy === staff.id} />
      <p className="text-xs text-muted">Author {p.createdBy.slice(0, 8)}{p.approvedBy ? ` · approved by ${p.approvedBy.slice(0, 8)} on ${fmtDate(p.approvedAt!)}` : ""}{p.archivedReason ? ` · archived: ${p.archivedReason}` : ""}</p>

      <section aria-labelledby="preview" className="space-y-3">
        <h2 id="preview" className="text-sm font-semibold uppercase tracking-wide text-muted">Preview as readers see it</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {previews.map(([l, items]) => (
            <Card key={l}>
              <CardHeader><CardTitle>{l === "en" ? "English" : "Hindi"}</CardTitle></CardHeader>
              <CardBody className="space-y-2" lang={l}>
                {items === null || items.length === 0 ? <Alert tone="warning">Nothing to show (a collection with no eligible picks is hidden).</Alert> : items.map((x) => (
                  <div key={x.id} className="space-y-1">
                    {x.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={x.image.src} alt={x.image.alt} className="max-h-40 rounded-lg border border-line object-cover" />
                    ) : null}
                    <p className="text-lg font-bold text-ink">{x.headline}</p>
                    {x.subline ? <p className="text-sm text-muted">{x.subline}</p> : null}
                    {x.cta ? <p className="text-sm"><span className="rounded-full bg-brand-600 px-3 py-1 text-white">{x.cta.label}</span> <code className="text-xs">{x.cta.href}</code></p> : null}
                    {p.kind === "collection" ? <p className="text-xs text-muted">{x.listingIds.length} of {p.items.length} picks pass eligibility right now.</p> : null}
                  </div>
                ))}
              </CardBody>
            </Card>
          ))}
        </div>
      </section>

      {editable ? (
        <section aria-labelledby="edit" className="space-y-3">
          <h2 id="edit" className="text-sm font-semibold uppercase tracking-wide text-muted">Edit</h2>
          <PromotionEditor value={value} />
        </section>
      ) : (
        <Alert tone="info">{p.status === "approved" ? "A live promotion cannot be edited. Archive it and create a new one." : p.status === "archived" ? "Archived promotions are read only." : "You can view this promotion but not edit it."}</Alert>
      )}
    </>
  );
}
