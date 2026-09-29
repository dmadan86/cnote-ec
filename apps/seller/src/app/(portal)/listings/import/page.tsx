import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Alert, PageHeader, buttonClasses } from "@cnote/ui";
import { listJobs } from "@cnote/bulk";
import { actorOf } from "@cnote/next-kit";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { catalogue } from "@/lib/services";
import { ImportWizard } from "@/features/bulk/import-wizard";

export const metadata: Metadata = { title: "Import listings" };

export default async function ImportPage() {
  const session = await requireSeller("/listings/import");
  const [cats, recent] = await Promise.all([
    load(() => catalogue.listCategories()),
    load(() => listJobs(actorOf(session), { kind: "import", limit: 5 })),
  ]);
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title="Import listings"
        description="Add or update many products at once from an Excel or CSV file, or a ZIP that also holds your product photos."
        actions={
          <Link href="/listings" className={buttonClasses("outline", "md", "min-h-11")}>
            <ArrowLeft className="size-4" aria-hidden /> Listings
          </Link>
        }
      />
      {!cats.ok ? <Alert tone="danger">{cats.error}</Alert> : null}
      <ImportWizard
        categories={cats.ok ? cats.data.filter((c) => !c.prohibited).map((c) => ({ slug: c.slug, name: c.name })) : []}
        recent={recent.ok ? recent.data.filter((j) => j.status !== "cancelled") : []}
      />
    </div>
  );
}
