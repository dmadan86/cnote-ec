"use client";
import { Alert, Button, Input, Textarea } from "@cnote/ui";
import { useRef, useState } from "react";

interface Brief { partner: string; businessName: string; address: string | null; scheduledFor: string | null; expiresAt: string; checklist: { id: string; label: string; required: boolean }[]; minPhotos: number; maxPhotos: number }
interface Shot { file: File; lat: number | null; lng: number | null; capturedAt: string | null; url: string }

const here = (): Promise<{ lat: number; lng: number } | null> =>
  new Promise((resolve) => {
    if (!("geolocation" in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }), () => resolve(null), { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 });
  });

/** Partner-facing T3 submission: checklist, geotagged site photos (location read from the device when each photo is added). */
export function PartnerAuditForm({ token, brief }: { token: string; brief: Brief }) {
  const [shots, setShots] = useState<Shot[]>([]);
  const [answers, setAnswers] = useState<Record<string, { ok: boolean; note?: string }>>({});
  const [inspector, setInspector] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    const pos = await here(); // read once per batch: the person is standing at the site while adding photos
    const next: Shot[] = [];
    for (const file of Array.from(files)) {
      if (shots.length + next.length >= brief.maxPhotos) break;
      const modified = file.lastModified && Date.now() - file.lastModified < 72 * 3_600_000 ? file.lastModified : Date.now();
      next.push({ file, lat: pos?.lat ?? null, lng: pos?.lng ?? null, capturedAt: new Date(modified).toISOString(), url: URL.createObjectURL(file) });
    }
    setShots((s) => [...s, ...next]);
    if (!pos) setError("Location is switched off, so these photos have no location. Allow location for this page and add them again.");
  };

  const missing = brief.checklist.filter((c) => c.required && !answers[c.id]);
  const ready = inspector.trim().length >= 2 && summary.trim().length >= 10 && shots.length >= brief.minPhotos && missing.length === 0;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const fd = new FormData();
    fd.set("inspector", inspector);
    fd.set("summary", summary);
    fd.set("answers", JSON.stringify(answers));
    fd.set("photos", JSON.stringify(shots.map(({ lat, lng, capturedAt }) => ({ lat, lng, capturedAt }))));
    shots.forEach((s, i) => fd.set(`photo${i}`, s.file));
    try {
      const res = await fetch(`/api/partner-audit/${encodeURIComponent(token)}`, { method: "POST", body: fd });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) setDone(true);
      else setError(body.error && body.error !== "internal" ? body.error : "The upload failed. Check your connection and try again.");
    } catch {
      setError("The upload failed. Check your connection and try again.");
    }
    setBusy(false);
  };

  if (done) return <Alert tone="success">Thank you. The audit has been submitted for review. You can close this page; the link no longer works.</Alert>;
  return (
    <div className="space-y-6">
      <section aria-labelledby="who" className="space-y-3">
        <h2 id="who" className="text-lg font-bold">Visit details</h2>
        <div><label htmlFor="pa-inspector" className="block text-sm font-medium">Inspector name</label><Input id="pa-inspector" value={inspector} onChange={(e) => setInspector(e.target.value)} required maxLength={120} autoComplete="name" /></div>
        <div><label htmlFor="pa-summary" className="block text-sm font-medium">Summary of the visit</label><Textarea id="pa-summary" value={summary} onChange={(e) => setSummary(e.target.value)} required minLength={10} maxLength={4000} className="min-h-24" /></div>
      </section>

      <section aria-labelledby="chk" className="space-y-3">
        <h2 id="chk" className="text-lg font-bold">Checklist</h2>
        <ul className="space-y-3">
          {brief.checklist.map((c) => (
            <li key={c.id}>
              <fieldset className="space-y-1">
                <legend className="text-sm">{c.label} {c.required ? <span className="text-xs text-muted">(required)</span> : null}</legend>
                <div className="flex gap-4">
                  {([true, false] as const).map((ok) => (
                    <label key={String(ok)} className="flex min-h-11 items-center gap-2 text-sm">
                      <input type="radio" name={`c-${c.id}`} checked={answers[c.id]?.ok === ok} onChange={() => setAnswers((a) => ({ ...a, [c.id]: { ...a[c.id], ok } }))} />{ok ? "Yes" : "No"}
                    </label>
                  ))}
                </div>
                {answers[c.id]?.ok === false ? (
                  <div><label htmlFor={`n-${c.id}`} className="sr-only">Note for {c.label}</label><Input id={`n-${c.id}`} placeholder="What did you see?" maxLength={300} value={answers[c.id]?.note ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, [c.id]: { ok: false, note: e.target.value } }))} /></div>
                ) : null}
              </fieldset>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="ph" className="space-y-3">
        <h2 id="ph" className="text-lg font-bold">Site photos</h2>
        <p className="text-sm text-muted">Take at least {brief.minPhotos} photos at the premises (name board, entrance, production or stock, machinery). Each photo is stamped with this device&apos;s location, so add them while you are on site.</p>
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" multiple className="sr-only" aria-label="Add site photos" onChange={(e) => { void add(e.target.files); e.target.value = ""; }} />
        <Button type="button" variant="outline" className="min-h-11" disabled={shots.length >= brief.maxPhotos} onClick={() => input.current?.click()}>Add photos ({shots.length}/{brief.maxPhotos})</Button>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {shots.map((s, i) => (
            <li key={s.url} className="space-y-1">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={s.url} alt={`Site photo ${i + 1}`} className="aspect-video w-full rounded border border-line object-cover" />
              <p className="text-xs text-muted">{s.lat !== null ? "Location captured" : "No location"}</p>
              <button type="button" className="min-h-11 text-xs text-danger underline" onClick={() => setShots((all) => all.filter((x) => x !== s))}>Remove</button>
            </li>
          ))}
        </ul>
      </section>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button type="button" className="min-h-11" disabled={!ready || busy} onClick={() => void submit()}>{busy ? "Uploading…" : "Submit audit"}</Button>
      {!ready ? <p className="text-xs text-muted">Needs the inspector name, a summary, every required checklist answer and at least {brief.minPhotos} photos.</p> : null}
    </div>
  );
}
