"use client";
import { useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { CheckCircle2, Clock, FileImage, ShieldAlert, Upload, Video } from "lucide-react";
import { Alert, Badge, Button } from "@cnote/ui";
import type { KycDocType, KycDocView, KycSessionView } from "@cnote/identity";
import { beginVideoKycAction, startKycAction } from "./actions";

/** What each document needs (shown before upload). Label and tips come from `verification.kyc.docs.<type>`. */
export const DOC_GUIDE: { type: KycDocType; required: boolean }[] = [
  { type: "gst_certificate", required: true },
  { type: "pan_card", required: true },
  { type: "udyam_certificate", required: false },
  { type: "bank_proof", required: false },
  { type: "address_proof", required: false },
];

const tone = (v: KycDocView["verdict"]) => (v === "pass" ? "success" : v === "fail" ? "danger" : "warning");

function upload(
  sessionId: string, docType: string, file: File, onProgress: (p: number) => void, msgs: { net: string; failed: string },
): Promise<{ document?: KycDocView; error?: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/kyc/documents");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onerror = () => resolve({ error: msgs.net });
    xhr.onload = () => {
      let body: { document?: KycDocView; error?: string } = {};
      try { body = JSON.parse(xhr.responseText); } catch {}
      resolve(xhr.status < 300 && body.document ? { document: body.document } : { error: body.error && body.error !== "internal" ? body.error : msgs.failed });
    };
    const fd = new FormData();
    fd.append("sessionId", sessionId);
    fd.append("docType", docType);
    fd.append("file", file);
    xhr.send(fd);
  });
}

function DocRow({ sessionId, guide, doc, locked, onDone }: { sessionId: string; guide: (typeof DOC_GUIDE)[number]; doc?: KycDocView; locked: boolean; onDone: (d: KycDocView) => void }) {
  const t = useTranslations("verification.kyc");
  const label = t(`docs.${guide.type}.label`);
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setProgress(0);
    const r = await upload(sessionId, guide.type, file, setProgress, { net: t("netError"), failed: t("uploadFailed") });
    setProgress(null);
    if (r.error) setError(r.error);
    else if (r.document) onDone(r.document);
  };
  return (
    <li className="rounded-card border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-semibold text-ink"><FileImage className="size-4 text-muted" aria-hidden />{label} {guide.required ? null : <span className="text-xs font-normal text-muted">{t("optional")}</span>}</p>
          <p className="mt-1 text-sm text-muted">{t(`docs.${guide.type}.tips`)}</p>
        </div>
        {doc ? <Badge tone={tone(doc.verdict)}>{t(`verdict.${doc.verdict}`)}</Badge> : <Badge>{t("notUploaded")}</Badge>}
      </div>
      {doc && doc.verdict !== "pass" && doc.reasons.length ? (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-muted">{doc.reasons.slice(0, 3).map((r) => <li key={r}>{r}</li>)}</ul>
      ) : null}
      {doc && doc.extracted.pan ? <p className="mt-2 text-xs text-muted">{t.rich("panRead", { pan: doc.extracted.pan, mono: (c) => <span className="font-mono">{c}</span> })}</p> : null}
      {progress !== null ? <div className="mt-3 h-1.5 overflow-hidden rounded bg-canvas" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><div className="h-full bg-brand-600" style={{ width: `${progress}%` }} /></div> : null}
      {error ? <Alert tone="danger" className="mt-3">{error}</Alert> : null}
      {!locked ? (
        <div className="mt-3">
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="sr-only" aria-label={t("chooseAria", { doc: label })} onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
          <Button type="button" variant={doc ? "outline" : "primary"} size="sm" className="min-h-11" disabled={progress !== null} onClick={() => input.current?.click()}>
            <Upload className="mr-1.5 size-4" aria-hidden />{doc ? t("replace") : t("upload")}
          </Button>
          <span className="ml-3 text-xs text-muted">{t("uploadHint")}</span>
        </div>
      ) : null}
    </li>
  );
}

export function KycPanel({ initial }: { initial: KycSessionView | null }) {
  const t = useTranslations("verification.kyc");
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
        {session?.status === "expired" ? <Alert tone="warning">{t("expired")}</Alert> : null}
        <p className="text-sm text-muted">{t("intro")}</p>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Button type="button" className="min-h-11" disabled={pending} onClick={() => start(async () => { const r = await startKycAction(); if (!r.ok) setError(r.error); else window.location.reload(); })}>{t("start")}</Button>
      </div>
    );
  }
  if (session.status === "approved") return <Alert tone="success"><CheckCircle2 className="mr-1 inline size-4" aria-hidden />{t("approved")}</Alert>;
  if (session.status === "rejected") return (
    <Alert tone="danger"><ShieldAlert className="mr-1 inline size-4" aria-hidden />{session.reviewNote ? t("rejectedNote", { note: session.reviewNote }) : t("rejected")}</Alert>
  );
  if (session.status === "review") return <Alert tone="info"><Clock className="mr-1 inline size-4" aria-hidden />{t("inReview")}</Alert>;

  const locked = session.status === "in_progress";
  const canStart = session.status === "initiated" && session.missingRequired.length === 0 && !session.documents.some((d) => d.verdict === "fail");
  return (
    <div className="space-y-4">
      <ol className="space-y-3" aria-label={t("docsLabel")}>
        {DOC_GUIDE.map((g) => <DocRow key={g.type} sessionId={session.id} guide={g} doc={session.documents.find((d) => d.docType === g.type)} locked={locked} onDone={refresh} />)}
      </ol>
      {locked ? (
        <Alert tone="info"><Clock className="mr-1 inline size-4" aria-hidden />{t.rich("videoStarted", { link: (c) => <a className="underline" href="">{c}</a> })}</Alert>
      ) : (
        <div className="rounded-card border border-line bg-surface p-4">
          <p className="font-semibold text-ink"><Video className="mr-1.5 inline size-4" aria-hidden />{t("videoTitle")}</p>
          <p className="mt-1 text-sm text-muted">{t("videoBody")}</p>
          {error ? <Alert tone="danger" className="mt-3">{error}</Alert> : null}
          <Button type="button" className="mt-3 min-h-11" disabled={!canStart || pending} onClick={() => start(async () => { setError(null); const r = await beginVideoKycAction(session.id); if (!r.ok) setError(r.error); else window.location.reload(); })}>
            {t("startVideo")}
          </Button>
          {!canStart ? <p className="mt-2 text-xs text-muted">{session.documents.some((d) => d.verdict === "fail") ? t("replaceFirst", { label: t("verdict.fail") }) : t("uploadFirst")}</p> : null}
        </div>
      )}
    </div>
  );
}
