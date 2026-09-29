"use client";
import type { StorefrontDocument } from "@cnote/storefront/document";
import { collectImages, placeholderOf } from "@cnote/storefront/document";
import { Alert, Badge, Field, Input } from "@cnote/ui";
import { ExternalLink, History } from "lucide-react";
import { useState, useTransition } from "react";
import { checkSlugAction, previewLinkAction, restoreVersionAction, setSlugAction } from "../actions";
import type { VersionLite } from "./types";

const btn = "inline-flex h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-4 text-sm font-medium text-ink hover:bg-canvas focus-visible:outline-2 focus-visible:outline-brand-600 disabled:opacity-50";

export function SettingsPanel({ doc, slug, liveBase, status, versions, onRestore, onSlug }: {
  doc: StorefrontDocument; slug: string; liveBase: string; status: string; versions: VersionLite[];
  onRestore: (document: unknown, etag: string) => void; onSlug: (slug: string) => void;
}) {
  const [pending, start] = useTransition();
  const [slugInput, setSlugInput] = useState(slug);
  const [slugMsg, setSlugMsg] = useState<{ tone: "success" | "danger" | "info"; text: string } | null>(null);
  const [preview, setPreview] = useState<{ url: string; expires: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const placeholders = collectImages(doc).filter((i) => placeholderOf(i.src)).length;
  const stockBlocks = doc.pages.flatMap((p) => p.sections).filter((s) => s.type === "stats" || s.type === "certifications" || s.type === "faq").length;

  return (
    <div className="space-y-6">
      <section aria-labelledby="addr-h" className="space-y-3">
        <h3 id="addr-h" className="text-sm font-semibold text-ink">Storefront address</h3>
        <Field label="Address" htmlFor="slug-input" hint={<>{liveBase}/store/<strong>{slugInput || "your-name"}</strong>. 3 to 40 characters: lowercase letters, digits and hyphens.</>}>
          <Input id="slug-input" value={slugInput} maxLength={40} spellCheck={false} onChange={(e) => { setSlugInput(e.target.value.toLowerCase()); setSlugMsg(null); }} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btn} disabled={pending || !slugInput || slugInput === slug} onClick={() => start(async () => {
            const r = await checkSlugAction(slugInput);
            if (!r.ok) setSlugMsg({ tone: "danger", text: r.error });
            else setSlugMsg(r.data.problem ? { tone: "danger", text: r.data.problem } : r.data.available ? { tone: "success", text: "That address is available." } : { tone: "danger", text: "That address is already taken." });
          })}>Check availability</button>
          <button type="button" className={btn} disabled={pending || !slugInput || slugInput === slug} onClick={() => start(async () => {
            if (status === "live" && !window.confirm("Changing the address of a live storefront breaks links people have already shared. Continue?")) return;
            const r = await setSlugAction(slugInput);
            if (!r.ok) setSlugMsg({ tone: "danger", text: r.error });
            else { onSlug(r.data.slug); setSlugMsg({ tone: "success", text: "Address updated." }); }
          })}>Save address</button>
        </div>
        {slugMsg ? <Alert tone={slugMsg.tone}>{slugMsg.text}</Alert> : null}
      </section>

      <section aria-labelledby="prev-h" className="space-y-3">
        <h3 id="prev-h" className="text-sm font-semibold text-ink">Preview link</h3>
        <p className="text-sm text-muted">Share your unpublished draft with someone for 30 minutes. Anyone with the link can view it; nobody can edit.</p>
        <button type="button" className={btn} disabled={pending} onClick={() => start(async () => {
          const r = await previewLinkAction();
          if (!r.ok) setMsg(r.error);
          else { setMsg(null); setPreview({ url: `${window.location.origin}${r.data.path}`, expires: new Date(r.data.expiresAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) }); }
        })}>Create preview link</button>
        {preview ? (
          <div className="space-y-2 rounded-lg border border-line bg-canvas p-3 text-sm">
            <p className="break-all font-mono text-xs">{preview.url}</p>
            <p className="text-muted">Expires at {preview.expires}.</p>
            <div className="flex gap-2">
              <button type="button" className={btn} onClick={() => void navigator.clipboard?.writeText(preview.url)}>Copy link</button>
              <a className={btn} href={preview.url} target="_blank" rel="noopener noreferrer">Open <ExternalLink className="size-3.5" aria-hidden /><span className="sr-only">(opens in a new tab)</span></a>
            </div>
          </div>
        ) : null}
        {msg ? <Alert tone="danger">{msg}</Alert> : null}
      </section>

      <section aria-labelledby="chk-h" className="space-y-2">
        <h3 id="chk-h" className="text-sm font-semibold text-ink">Before you publish</h3>
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
          <li>{placeholders ? `${placeholders} image${placeholders === 1 ? " is" : "s are"} still placeholder illustrations. Replace them with your own approved photos.` : "No placeholder images left."}</li>
          {stockBlocks ? <li>Check the numbers, certifications and FAQ answers. Template text is a starting point, and buyers will read it as fact.</li> : null}
          <li>Text is screened automatically. Content that looks risky is held for a quick human review; nothing flagged goes live before that.</li>
          <li>Images must be approved listing images; external image links are not allowed.</li>
        </ul>
      </section>

      <section aria-labelledby="ver-h" className="space-y-2">
        <h3 id="ver-h" className="flex items-center gap-1.5 text-sm font-semibold text-ink"><History className="size-4" aria-hidden /> Version history</h3>
        {versions.length === 0 ? <p className="text-sm text-muted">No versions yet.</p> : (
          <ul className="divide-y divide-line rounded-lg border border-line text-sm">
            {versions.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="font-medium">v{v.version}</span>
                <Badge tone={v.status === "published" ? "success" : v.status === "in_review" ? "warning" : v.status === "rejected" ? "danger" : "neutral"}>{v.status.replace("_", " ")}</Badge>
                <span className="text-muted">{new Date(v.publishedAt ?? v.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span>
                <button type="button" className="ml-auto text-sm font-medium text-brand-700 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600" disabled={pending}
                  onClick={() => { if (!window.confirm(`Copy version ${v.version} into your working draft? Your current draft changes are replaced (they stay recoverable only if saved).`)) return; start(async () => { const r = await restoreVersionAction(v.id); if (r.ok) onRestore(r.data.document, r.data.etag); else setMsg(r.error); }); }}>
                  Restore<span className="sr-only"> version {v.version}</span>
                </button>
                {v.reviewNote ? <p className="w-full text-xs text-muted">Reviewer note: {v.reviewNote}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
