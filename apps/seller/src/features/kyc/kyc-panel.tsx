"use client";
import { useRef, useState, useTransition } from "react";
import { CheckCircle2, Clock, FileImage, ShieldAlert, Upload, Video } from "lucide-react";
import { Alert, Badge, Button } from "@cnote/ui";
import type { KycDocType, KycDocView, KycSessionView } from "@cnote/identity";
import { beginVideoKycAction, startKycAction } from "./actions";

/** What each document needs (shown before upload; wording mirrors what the checks look for). */
export const DOC_GUIDE: { type: KycDocType; label: string; required: boolean; tips: string }[] = [
  { type: "gst_certificate", label: "GST registration certificate", required: true, tips: "Page 1 of the GST REG-06 certificate. GSTIN, legal name and address must be readable." },
  { type: "pan_card", label: "PAN card", required: true, tips: "Photo of the PAN card of the business or proprietor. Name and PAN number must be readable." },
  { type: "udyam_certificate", label: "Udyam certificate", required: false, tips: "Optional. Helps MSME status." },
  { type: "bank_proof", label: "Bank proof", required: false, tips: "Optional. Cancelled cheque or first page of a statement. Only the last 4 digits of the account are kept." },
  { type: "address_proof", label: "Address proof", required: false, tips: "Optional. Electricity bill or rent agreement page showing the business address." },
];

const tone = (v: KycDocView["verdict"]) => (v === "pass" ? "success" : v === "fail" ? "danger" : "warning");
const verdictText = (v: KycDocView["verdict"]) => (v === "pass" ? "Looks good" : v === "fail" ? "Needs a new photo" : "Under review");

function upload(sessionId: string, docType: string, file: File, onProgress: (p: number) => void): Promise<{ document?: KycDocView; error?: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/kyc/documents");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onerror = () => resolve({ error: "Network problem. Please try again." });
    xhr.onload = () => {
      let body: { document?: KycDocView; error?: string } = {};
      try { body = JSON.parse(xhr.responseText); } catch {}
      resolve(xhr.status < 300 && body.document ? { document: body.document } : { error: body.error && body.error !== "internal" ? body.error : "Upload failed. Please try again." });
    };
    const fd = new FormData();
    fd.append("sessionId", sessionId);
    fd.append("docType", docType);
    fd.append("file", file);
    xhr.send(fd);
  });
}

function DocRow({ sessionId, guide, doc, locked, onDone }: { sessionId: string; guide: (typeof DOC_GUIDE)[number]; doc?: KycDocView; locked: boolean; onDone: (d: KycDocView) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setProgress(0);
    const r = await upload(sessionId, guide.type, file, setProgress);
    setProgress(null);
    if (r.error) setError(r.error);
    else if (r.document) onDone(r.document);
  };
  return (
    <li className="rounded-card border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-semibold text-ink"><FileImage className="size-4 text-muted" aria-hidden />{guide.label} {guide.required ? null : <span className="text-xs font-normal text-muted">(optional)</span>}</p>
          <p className="mt-1 text-sm text-muted">{guide.tips}</p>
        </div>
        {doc ? <Badge tone={tone(doc.verdict)}>{verdictText(doc.verdict)}</Badge> : <Badge>Not uploaded</Badge>}
      </div>
      {doc && doc.verdict !== "pass" && doc.reasons.length ? (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-muted">{doc.reasons.slice(0, 3).map((r) => <li key={r}>{r}</li>)}</ul>
      ) : null}
      {doc && doc.extracted.pan ? <p className="mt-2 text-xs text-muted">PAN read as <span className="font-mono">{doc.extracted.pan}</span></p> : null}
      {progress !== null ? <div className="mt-3 h-1.5 overflow-hidden rounded bg-canvas" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><div className="h-full bg-brand-600" style={{ width: `${progress}%` }} /></div> : null}
      {error ? <Alert tone="danger" className="mt-3">{error}</Alert> : null}
      {!locked ? (
        <div className="mt-3">
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="sr-only" aria-label={`Choose a photo of ${guide.label}`} onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
          <Button type="button" variant={doc ? "outline" : "primary"} size="sm" className="min-h-11" disabled={progress !== null} onClick={() => input.current?.click()}>
            <Upload className="mr-1.5 size-4" aria-hidden />{doc ? "Replace photo" : "Upload photo"}
          </Button>
          <span className="ml-3 text-xs text-muted">JPEG, PNG or WebP, up to 5 MB. No PDFs yet: photograph or screenshot page 1.</span>
        </div>
      ) : null}
    </li>
  );
}

export function KycPanel({ initial }: { initial: KycSessionView | null }) {
  const [session, setSession] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const refresh = (d: KycDocView) =>
    setSession((s) => {
      if (!s) return s;
      const documents = [...s.documents.filter((x) => x.docType !== d.docType), d];
      const have = new Set(documents.filter((x) => x.verdict !== "fail").map((x) => x.docType));
      return { ...s, documents, missingRequired: s.missingRequired.filter((t) => !have.has(t)) };
    });

  if (!session || session.status === "expired") {
    return (
      <div className="space-y-3">
        {session?.status === "expired" ? <Alert tone="warning">Your last KYC attempt expired. Start again; it takes about 10 minutes.</Alert> : null}
        <p className="text-sm text-muted">You will need your GST certificate and PAN card, then a short video check on your phone (a live selfie matched to your PAN photo). Only the owner or authorised signatory can do this.</p>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Button type="button" className="min-h-11" disabled={pending} onClick={() => start(async () => { const r = await startKycAction(); if (!r.ok) setError(r.error); else window.location.reload(); })}>Start KYC</Button>
      </div>
    );
  }
  if (session.status === "approved") return <Alert tone="success"><CheckCircle2 className="mr-1 inline size-4" aria-hidden />KYC verified. Your badge now shows Tier 2.</Alert>;
  if (session.status === "rejected") return (
    <Alert tone="danger"><ShieldAlert className="mr-1 inline size-4" aria-hidden />We could not verify your KYC{session.reviewNote ? `: ${session.reviewNote}` : "."} Contact support to try again with corrected documents.</Alert>
  );
  if (session.status === "review") return <Alert tone="info"><Clock className="mr-1 inline size-4" aria-hidden />Submitted. A verification officer is reviewing your documents. This usually takes one working day.</Alert>;

  const locked = session.status === "in_progress";
  const canStart = session.status === "initiated" && session.missingRequired.length === 0 && !session.documents.some((d) => d.verdict === "fail");
  return (
    <div className="space-y-4">
      <ol className="space-y-3" aria-label="KYC documents">
        {DOC_GUIDE.map((g) => <DocRow key={g.type} sessionId={session.id} guide={g} doc={session.documents.find((d) => d.docType === g.type)} locked={locked} onDone={refresh} />)}
      </ol>
      {locked ? (
        <Alert tone="info"><Clock className="mr-1 inline size-4" aria-hidden />Video check started. Finish it on the provider page; this page updates when the result arrives. <a className="underline" href="">Refresh</a></Alert>
      ) : (
        <div className="rounded-card border border-line bg-surface p-4">
          <p className="font-semibold text-ink"><Video className="mr-1.5 inline size-4" aria-hidden />Video check</p>
          <p className="mt-1 text-sm text-muted">A hosted page opens on your phone or computer camera: a live selfie and a short liveness check. We keep only the result scores, never the video or face template.</p>
          {error ? <Alert tone="danger" className="mt-3">{error}</Alert> : null}
          <Button type="button" className="mt-3 min-h-11" disabled={!canStart || pending} onClick={() => start(async () => { setError(null); const r = await beginVideoKycAction(session.id); if (!r.ok) setError(r.error); else window.location.reload(); })}>
            Start video KYC
          </Button>
          {!canStart ? <p className="mt-2 text-xs text-muted">{session.documents.some((d) => d.verdict === "fail") ? "Replace the documents marked \"Needs a new photo\" first." : "Upload the GST certificate and PAN card first."}</p> : null}
        </div>
      )}
    </div>
  );
}
