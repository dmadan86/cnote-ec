import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Alert, PageHeader, buttonClasses } from "@cnote/ui";
import { listJobs } from "@cnote/bulk";
import { actorOf } from "@cnote/next-kit";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { ExportPanel } from "@/features/bulk/export-panel";

export const metadata: Metadata = { title: "Export listings" };

export default async function ExportPage() {
  const session = await requireSeller("/listings/export");
  const jobs = await load(() => listJobs(actorOf(session), { kind: "export", limit: 10 }));
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title="Export listings"
        description="Download your catalogue as Excel or CSV, optionally with photos."
        actions={
          <Link href="/listings" className={buttonClasses("outline", "md", "min-h-11")}>
            <ArrowLeft className="size-4" aria-hidden /> Listings
          </Link>
        }
      />
      {!jobs.ok ? <Alert tone="danger">{jobs.error}</Alert> : null}
      <ExportPanel initialJobs={jobs.ok ? jobs.data : []} />
    </div>
  );
}
