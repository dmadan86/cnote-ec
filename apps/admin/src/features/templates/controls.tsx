"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, Input, Select } from "@cnote/ui";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createLocaleAction, deleteAssetAction, seedDefaultsAction, setEnabledAction, setLayoutAction } from "./actions";

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ tone: "danger" | "success"; text: string } | null>(null);
  const run = (fn: () => Promise<ActionResult<unknown>>, ok: string, then?: (r: ActionResult<unknown>) => void) => {
    setMsg(null);
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? { tone: "success", text: ok } : { tone: "danger", text: r.error });
      if (r.ok) router.refresh();
      then?.(r);
    });
  };
  return { pending, msg, run };
}

export function EnabledToggle({ templateId, enabled, disabled, label }: { templateId: string; enabled: boolean; disabled: boolean; label: string }) {
  const { pending, msg, run } = useRun();
  return (
    <span className="inline-flex flex-col">
      <label className="inline-flex items-center gap-2 text-xs">
        <input type="checkbox" role="switch" aria-label={`${label} enabled`} checked={enabled} disabled={disabled || pending} onChange={(e) => run(() => setEnabledAction(templateId, e.target.checked), "Updated.")} className="size-4 accent-brand-600" />
        {enabled ? "On" : "Off"}
      </label>
      {msg?.tone === "danger" ? <span role="alert" className="text-xs text-danger">{msg.text}</span> : null}
    </span>
  );
}

export function SeedButton() {
  const { pending, msg, run } = useRun();
  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="outline" disabled={pending} onClick={() => run(() => seedDefaultsAction(), "Defaults created.")}>{pending ? "Working…" : "Create missing defaults"}</Button>
      {msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null}
    </div>
  );
}

export function LayoutSelect({ templateId, layoutId, layouts, disabled }: { templateId: string; layoutId: string | null; layouts: { id: string; name: string; key: string }[]; disabled: boolean }) {
  const { pending, msg, run } = useRun();
  const def = layouts.find((l) => l.key === "default");
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="tpl-layout" className="text-sm font-medium">Layout</label>
      <Select id="tpl-layout" className="w-56" value={layoutId ?? def?.id ?? ""} disabled={disabled || pending} onChange={(e) => run(() => setLayoutAction(templateId, e.target.value === def?.id ? null : e.target.value), "Layout updated.")}>
        {layouts.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </Select>
      {msg?.tone === "danger" ? <p role="alert" className="text-xs text-danger">{msg.text}</p> : null}
    </div>
  );
}

export function AddLocale({ templateKey, channel }: { templateKey: string; channel: "email" | "in_app" | "sms" | "whatsapp" }) {
  const router = useRouter();
  const { pending, msg, run } = useRun();
  const [locale, setLocale] = useState("");
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => createLocaleAction(templateKey, channel, locale), "Locale created.", (r) => { if (r.ok) router.push(`/templates/${(r.data as { id: string }).id}`); });
      }}
    >
      <label htmlFor="tpl-locale" className="text-sm font-medium">Add a language</label>
      <div className="flex gap-2">
        <Input id="tpl-locale" className="w-28" placeholder="hi, ta, en-IN" value={locale} onChange={(e) => setLocale(e.target.value)} maxLength={12} />
        <Button type="submit" variant="outline" disabled={pending || !locale.trim()}>Add</Button>
      </div>
      {msg?.tone === "danger" ? <p role="alert" className="text-xs text-danger">{msg.text}</p> : null}
    </form>
  );
}

export function DeleteAssetButton({ assetId, inUse }: { assetId: string; inUse: boolean }) {
  const { pending, msg, run } = useRun();
  return (
    <div>
      <Button size="sm" variant="ghost" className="text-danger" disabled={pending || inUse} title={inUse ? "In use by a template or layout version" : undefined} onClick={() => { if (window.confirm("Delete this image?")) run(() => deleteAssetAction(assetId), "Deleted."); }}>
        Delete
      </Button>
      {msg?.tone === "danger" ? <p role="alert" className="text-xs text-danger">{msg.text}</p> : null}
    </div>
  );
}
