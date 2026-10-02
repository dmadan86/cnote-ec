import { getDisputeForStaff } from "@/lib/disputes";
import { hasPrivilege } from "@cnote/admin";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Mono, Table, Td, Th } from "@/components/table";
import { AppealForm, DecisionForm, StaffMessageForm } from "@/features/disputes/forms";
import { inr } from "@/features/payments/format";
import { requireStaff } from "@/lib/auth";
import { fmtDate, safe } from "@/lib/util";

export const metadata = { title: "Dispute" };
export const dynamic = "force-dynamic";
const OUTCOME: Record<string, string> = { buyer_favour: "In favour of the buyer", seller_favour: "In favour of the seller", split: "Split", withdrawn: "Withdrawn" };

export default async function DisputeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { staff } = await requireStaff(`/disputes/${id}`, "disputes.read");
  const d = await safe("disputes.detail", () => getDisputeForStaff(id));
  if (!d) notFound();
  const canDecide = hasPrivilege(staff, "disputes.adjudicate");
  const brief = d.briefs[0] ?? null;
  const decidable = ["evidence", "brief_ready", "awaiting_adjudication"].includes(d.status);
  const cited = new Set(brief?.citedEvidenceIds ?? []);
  const roleOf = (b: string | null) => (b === d.buyerBusinessId ? "Buyer" : b === d.sellerBusinessId ? "Seller" : "System");
  return (
    <>
      <PageHeader title={`Dispute ${id.slice(0, 8)}`} description={`${d.type.replace(/_/g, " ")} · order ${d.orderId.slice(0, 8)}`} actions={<Badge tone={d.overdue ? "danger" : "brand"}>{d.status.replace(/_/g, " ")}</Badge>} />
      <Card>
        <CardBody className="grid gap-2 text-sm sm:grid-cols-2">
          <p>Buyer: <Link className="font-medium text-brand-700 hover:underline" href={`/businesses/${d.buyerBusinessId}`}><Mono>{d.buyerBusinessId}</Mono></Link></p>
          <p>Seller: <Link className="font-medium text-brand-700 hover:underline" href={`/businesses/${d.sellerBusinessId}`}><Mono>{d.sellerBusinessId}</Mono></Link></p>
          <p>Amount held: <strong>{inr(d.atStakePaise)}</strong> · Claimed: {d.amountPaise === null ? "not stated" : inr(d.amountPaise)}</p>
          <p>Opened {fmtDate(d.createdAt)} · SLA due {fmtDate(d.dueAt)}{d.overdue ? " (overdue)" : ""} · Response window ends {fmtDate(d.responseDueAt)}</p>
          <p className="sm:col-span-2 whitespace-pre-wrap">{d.description}</p>
        </CardBody>
      </Card>
      {d.evidenceAfterBrief > 0 ? <Alert tone="warning">{d.evidenceAfterBrief} evidence item(s) were added after the AI brief was written. Read them before deciding.</Alert> : null}
      {d.proposal ? <Alert tone="info">Auto-resolution proposed: {OUTCOME[d.proposal.outcome]} (refund {inr(d.proposal.refundPaise)}, release {inr(d.proposal.releasePaise)}). Applies after {fmtDate(d.proposal.escalationDeadline)} unless escalated.</Alert> : null}

      <Card>
        <CardHeader><CardTitle>AI brief</CardTitle></CardHeader>
        <CardBody className="space-y-3 text-sm">
          {!brief ? <p className="text-muted">No brief yet: evidence is still being collected.</p> : (
            <>
              <p className="text-xs text-muted">v{brief.version} · {brief.provider} / <Mono>{brief.modelId}</Mono> · prompt <Mono>{brief.promptVersion}</Mono> · {brief.evidenceCount} evidence items · {fmtDate(brief.createdAt)}. Advisory only.</p>
              <p><Badge tone={brief.confidence >= 0.85 ? "success" : brief.confidence >= 0.6 ? "warning" : "danger"}>confidence {brief.confidence.toFixed(2)}</Badge> {brief.needsReview ? <Badge tone="warning" className="ml-1">low confidence: needs human review</Badge> : null} {brief.autoResolvable ? <Badge tone="brand" className="ml-1">auto-resolvable</Badge> : null}</p>
              <p>Classified as <strong>{brief.classifiedType.replace(/_/g, " ")}</strong>{brief.classifiedType !== d.type ? ` (claimed: ${d.type.replace(/_/g, " ")})` : ""}.</p>
              <p className="whitespace-pre-wrap">{brief.summary}</p>
              <p><strong>Recommendation:</strong> {OUTCOME[brief.recommendedOutcome]}: refund {inr(brief.recommendedRefundPaise)}, release {inr(brief.recommendedReleasePaise)}.<br /><span className="text-muted">{brief.rationale}</span></p>
              <div>
                <p className="mb-1 font-medium">Spec check against the order (verdict: {brief.specVerdict.replace(/_/g, " ")})</p>
                {brief.specChecks.length === 0 ? <p className="text-muted">No structured checks.</p> : (
                  <Table><thead><tr><Th>Field</Th><Th>Agreed</Th><Th>Claimed / found</Th><Th>Match</Th></tr></thead><tbody>
                    {brief.specChecks.map((c, i) => <tr key={i}><Td>{c.field}</Td><Td>{c.agreed}</Td><Td>{c.claimed}</Td><Td><Badge tone={c.match === "match" ? "success" : c.match === "mismatch" ? "danger" : "neutral"}>{c.match}</Badge></Td></tr>)}
                  </tbody></Table>
                )}
              </div>
            </>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>Evidence ({d.evidence.length})</CardTitle></CardHeader>
        <CardBody>
          <ul className="space-y-3">
            {d.evidence.map((e) => (
              <li key={e.id} className={`rounded-lg border p-3 text-sm ${cited.has(e.id) ? "border-brand-600 bg-brand-50" : "border-line"}`}>
                <p className="text-xs text-muted">{e.party === "system" ? `System (${e.source})` : roleOf(e.submittedByBusinessId)} · {e.kind}{e.language ? ` · ${e.language}` : ""} · {fmtDate(e.createdAt)}{cited.has(e.id) ? " · cited by the AI brief" : ""}<span className="ml-2"><Mono>{e.id.slice(0, 8)}</Mono></span></p>
                {e.purged ? <p className="text-muted">Removed under the retention policy.</p> : null}
                {e.text ? <p className="mt-1 whitespace-pre-wrap">{e.text}</p> : null}
                {/* eslint-disable-next-line @next/next/no-img-element -- private, no-store evidence served by our own route; the optimiser must not cache it */}
                {e.hasFile && !e.purged && e.mimeType?.startsWith("image/") ? <a href={`/media/disputes/${d.id}/${e.id}`} target="_blank" rel="noreferrer"><img src={`/media/disputes/${d.id}/${e.id}`} alt={`Evidence photo ${e.id.slice(0, 8)}`} className="mt-2 max-h-64 rounded-lg border border-line" /></a> : null}
                {e.hasFile && !e.purged && e.mimeType?.startsWith("audio/") ? <audio controls className="mt-2 w-full" src={`/media/disputes/${d.id}/${e.id}`} /> : null}
                {e.hasFile && !e.purged && e.mimeType === "application/pdf" ? <a className="mt-2 inline-block text-brand-700 underline" href={`/media/disputes/${d.id}/${e.id}`} target="_blank" rel="noreferrer">Open PDF</a> : null}
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      {d.decision ? (
        <Card><CardHeader><CardTitle>Decision</CardTitle></CardHeader><CardBody className="space-y-1 text-sm">
          <p><strong>{OUTCOME[d.decision.outcome]}</strong> · refund {inr(d.decision.refundPaise)} · release {inr(d.decision.releasePaise)} · decided {d.decision.decidedBy === "auto" ? "automatically" : "by staff"} {fmtDate(d.decision.createdAt)}{d.decision.followedRecommendation ? " (followed the AI recommendation)" : ""}</p>
          <p className="text-muted">{d.decision.rationale}</p>
        </CardBody></Card>
      ) : canDecide && decidable ? (
        <Card><CardHeader><CardTitle>Decide</CardTitle></CardHeader><CardBody>
          <DecisionForm disputeId={d.id} atStakeRupees={d.atStakePaise / 100} hasBrief={!!brief} recommended={brief?.recommendedOutcome ?? null} />
        </CardBody></Card>
      ) : d.status === "auto_resolved" ? null : !decidable ? null : <Alert tone="info">You can read this case but not decide it (needs disputes.adjudicate).</Alert>}

      {d.appeals.length > 0 ? (
        <Card><CardHeader><CardTitle>Appeals</CardTitle></CardHeader><CardBody className="space-y-4 text-sm">
          {d.appeals.map((a) => (
            <div key={a.id} className="space-y-2">
              <p><Badge tone={a.status === "open" ? "danger" : "neutral"}>{a.status}</Badge> by {roleOf(a.byBusinessId)} · {fmtDate(a.createdAt)}</p>
              <p className="whitespace-pre-wrap">{a.reason}</p>
              {a.status !== "open" ? <p className="text-muted">{a.resolutionNote}{a.newOutcome ? ` → ${OUTCOME[a.newOutcome]} (refund ${inr(a.newRefundPaise ?? 0)})` : ""}</p> : canDecide ? <AppealForm disputeId={d.id} appealId={a.id} atStakeRupees={d.atStakePaise / 100} /> : null}
            </div>
          ))}
        </CardBody></Card>
      ) : null}

      <Card><CardHeader><CardTitle>Messages</CardTitle></CardHeader><CardBody className="space-y-4">
        {[d.buyerBusinessId, d.sellerBusinessId].map((b) => {
          const t = d.threads.find((x) => x.partyBusinessId === b);
          return (
            <div key={b} className="space-y-2">
              <p className="text-sm font-medium">{roleOf(b)} thread</p>
              <ul className="space-y-1 text-sm">{(t?.messages ?? []).map((m) => <li key={m.id} className="rounded-lg bg-surface-2 p-2"><span className="text-xs text-muted">{m.authorType === "staff" ? "Staff" : roleOf(b)} · {fmtDate(m.createdAt)}</span><br />{m.body}</li>)}</ul>
              {canDecide ? <StaffMessageForm disputeId={d.id} partyBusinessId={b} label={`Message the ${roleOf(b).toLowerCase()}`} /> : null}
            </div>
          );
        })}
      </CardBody></Card>
    </>
  );
}
