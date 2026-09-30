import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Alert, PageHeader, buttonClasses } from "@cnote/ui";
import { listJobs } from "@cnote/bulk";
import { actorOf } from "@cnote/next-kit";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { catalogue } from "@/lib/services";
import { ImportWizard } from "@/features/bulk/import-wizard";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("listings.meta"))("import") };
}

export default async function ImportPage() {
  const t = await getTranslations("listings.importPage");
  const tc = await getTranslations("listings.exportPage");
  const session = await requireSeller("/listings/import");
  const [cats, recent] = await Promise.all([
    load(() => catalogue.listCategories()),
    load(() => listJobs(actorOf(session), { kind: "import", limit: 5 })),
  ]);
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <Link href="/listings" className={buttonClasses("outline", "md", "min-h-11")}>
            <ArrowLeft className="size-4" aria-hidden /> {tc("back")}
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
