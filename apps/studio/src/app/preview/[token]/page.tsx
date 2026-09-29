import { getDraftByPreviewToken } from "@cnote/storefront";
import { StorefrontView, findPage, type RenderHrefs } from "@cnote/storefront/render";
import { Eye } from "lucide-react";
import type { Metadata } from "next";
import { WEB_APP_URL } from "@/lib/env";

// Token-authenticated (HMAC, 30 min) render of the CURRENT DRAFT. Never cached, never indexed.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Draft preview", robots: { index: false, follow: false } };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function PreviewPage(props: PageProps<"/preview/[token]">) {
  const { token } = await props.params;
  const sp = await props.searchParams;
  const p = await getDraftByPreviewToken(token).catch(() => null);
  if (!p) {
    return (
      <main className="mx-auto max-w-md px-4 py-24 text-center">
        <h1 className="text-xl font-bold text-ink">This preview link has expired</h1>
        <p className="mt-2 text-sm text-muted">Preview links last 30 minutes. Ask the seller to generate a new one from Storefront Studio.</p>
      </main>
    );
  }
  const page = findPage(p.document, first(sp.page));
  const hrefs: RenderHrefs = {
    page: (s) => `/preview/${token}?page=${s}`,
    product: (x) => `${WEB_APP_URL}/p/${x.id}`,
    rfq: `${WEB_APP_URL}/rfq/new?seller=${p.data.business.id}`,
  };
  return (
    <div>
      <div role="status" className="flex items-center justify-center gap-2 bg-ink px-4 py-2 text-center text-sm text-white">
        <Eye className="size-4 shrink-0" aria-hidden /> Draft preview. Not public. Only people with this link can see it, and it expires soon.
      </div>
      <StorefrontView document={p.document} pageSlug={page.slug} data={p.data} hrefs={hrefs} preview />
    </div>
  );
}
