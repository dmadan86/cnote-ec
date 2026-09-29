import { getImageForModeration } from "@cnote/catalogue";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Mono } from "@/components/table";
import { ImageDecisionForm } from "@/features/images/decision-form";
import { canModerateImages, canViewImages } from "@/features/images/privilege";
import { requireStaff } from "@/lib/auth";
import { fmtDate, safe } from "@/lib/util";

export const metadata = { title: "Image review" };

const STATUS_TONE = { pending: "neutral", flagged: "warning", approved: "success", rejected: "danger" } as const;

export default async function ImageDetailPage({ params }: PageProps<"/images/[id]">) {
  const { id } = await params;
  const { staff } = await requireStaff(`/images/${id}`);
  if (!canViewImages(staff)) redirect("/no-access?need=images.moderate");
  const img = await safe("catalogue.getImageForModeration", () => getImageForModeration(id));
  if (!img) notFound();

  return (
    <>
      <PageHeader title="Image review" description={<><Link href="/images" className="text-brand-700 hover:underline">Queue</Link> · uploaded {fmtDate(img.createdAt)}</>} />
      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <Card>
          <CardBody>
            {/* eslint-disable-next-line @next/next/no-img-element -- staff-gated no-store route */}
            <img src={img.url} alt={img.altText ?? `Uploaded photo for ${img.listingTitle}`} className="max-h-[75vh] w-full rounded-lg bg-canvas object-contain" />
          </CardBody>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Details</CardTitle><Badge tone={STATUS_TONE[img.status]}>{img.status}</Badge></CardHeader>
            <CardBody>
              <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted">Listing</dt><dd className="font-medium">{img.listingTitle}</dd>
                <dt className="text-muted">Seller</dt><dd>{img.sellerName}</dd>
                <dt className="text-muted">Size</dt><dd>{img.width ?? "?"}×{img.height ?? "?"} px · {(img.bytes / 1024).toFixed(0)} KB · {img.mimeType}</dd>
                <dt className="text-muted">AI verdict</dt><dd>{img.aiVerdict ?? "None"}</dd>
                <dt className="text-muted">Alt text</dt><dd>{img.altText ?? "None"}</dd>
                {img.moderationNote ? <><dt className="text-muted">Last note</dt><dd>{img.moderationNote}</dd></> : null}
                <dt className="text-muted">Image ID</dt><dd><Mono>{img.id.slice(0, 8)}</Mono></dd>
              </dl>
              <p className="mt-3 text-xs text-muted">The AI pre-screen only checks the alt text and file name today. It never approves an image; a person must look at the picture.</p>
            </CardBody>
          </Card>
          {canModerateImages(staff) ? (
            <Card>
              <CardHeader><CardTitle>Decision</CardTitle></CardHeader>
              <CardBody><ImageDecisionForm id={img.id} /></CardBody>
            </Card>
          ) : (
            <Alert tone="info">Your role can view this image but not decide on it.</Alert>
          )}
        </div>
      </div>
    </>
  );
}
