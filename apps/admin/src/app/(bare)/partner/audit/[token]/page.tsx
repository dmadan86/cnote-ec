import { getAuditBriefForPartner } from "@cnote/identity";
import { Alert } from "@cnote/ui";
import { PartnerAuditForm } from "@/features/kyc/partner-audit-form";

export const metadata = { title: "Site audit upload", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** Public, token-authenticated page for an external audit partner (no sign-in). The link is single use and expires. */
export default async function PartnerAuditPage({ params }: PageProps<"/partner/audit/[token]">) {
  const { token } = await params;
  let brief: Awaited<ReturnType<typeof getAuditBriefForPartner>> | null = null;
  try { brief = await getAuditBriefForPartner(token); } catch { brief = null; }
  return (
    <main className="mx-auto max-w-2xl space-y-6 px-4 py-8">
      <h1 className="text-2xl font-bold">Site audit upload</h1>
      {brief ? (
        <>
          <div className="rounded-card border border-line bg-surface p-4 text-sm">
            <p><span className="font-semibold">{brief.businessName}</span></p>
            {brief.address ? <p className="text-muted">{brief.address}</p> : null}
            <p className="mt-1 text-muted">For {brief.partner}{brief.scheduledFor ? ` · scheduled ${new Date(brief.scheduledFor).toLocaleDateString("en-IN")}` : ""} · link valid until {new Date(brief.expiresAt).toLocaleDateString("en-IN")}</p>
          </div>
          <PartnerAuditForm token={token} brief={brief} />
        </>
      ) : <Alert tone="warning">This link is not valid, has expired or was already used. Ask the platform team for a new one.</Alert>}
    </main>
  );
}
