import { getDraft, getEditorData, getOrCreateStorefront, listApprovedSellerImages, listVersions } from "@cnote/storefront";
import { Editor } from "@/features/studio/editor/editor";
import { requireSellerSession } from "@/lib/auth";
import { WEB_APP_URL } from "@/lib/env";

export const metadata = { title: "Editor" };
export const dynamic = "force-dynamic";

export default async function EditorPage() {
  const session = await requireSellerSession("/editor");
  const biz = session.business!;
  const sf = await getOrCreateStorefront(biz.id, session.personId);
  const [draft, data, images, versions] = await Promise.all([
    getDraft(biz.id, session.personId),
    getEditorData(biz.id),
    listApprovedSellerImages(biz.id).catch(() => []),
    listVersions(biz.id),
  ]);
  return (
    <Editor
      initial={{
        document: draft.document,
        etag: draft.etag,
        slug: sf.slug,
        status: sf.status,
        templateKey: sf.templateKey,
        sellerName: biz.name,
        liveBase: WEB_APP_URL,
        versions: versions.map((v) => ({ id: v.id, version: v.version, status: v.status, createdAt: v.createdAt, publishedAt: v.publishedAt, reviewNote: v.reviewNote })),
      }}
      editor={{ data, images: images.map((i) => ({ id: i.id, url: i.url, alt: i.alt })) }}
    />
  );
}
