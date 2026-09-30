import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Alert, PageHeader, buttonClasses } from "@cnote/ui";
import { listJobs } from "@cnote/bulk";
import { actorOf } from "@cnote/next-kit";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { ExportPanel } from "@/features/bulk/export-panel";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("listings.meta"))("export") };
}

export default async function ExportPage() {
  const t = await getTranslations("listings.exportPage");
  const session = await requireSeller("/listings/export");
  const jobs = await load(() => listJobs(actorOf(session), { kind: "export", limit: 10 }));
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <Link href="/listings" className={buttonClasses("outline", "md", "min-h-11")}>
            <ArrowLeft className="size-4" aria-hidden /> {t("back")}
          </Link>
        }
      />
      {!jobs.ok ? <Alert tone="danger">{jobs.error}</Alert> : null}
      <ExportPanel initialJobs={jobs.ok ? jobs.data : []} />
    </div>
  );
}
