"use client";
// Personal API key management UI (shared by web, seller and admin). Framework-free: server actions
// come in as props; scope/expiry definitions are passed in so this package needs no domain imports.
import { Check, Copy } from "lucide-react";
import { useActionState, useId, useState } from "react";
import { cn } from "../cn";
import { Badge } from "./badge";
import { Button } from "./button";
import { Alert } from "./layout";
import { Field, Input, Select } from "./form";

export type TokenActionState<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string> }
  | null;

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  /** display name of the business the key acts for */
  businessName?: string | null;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  status: "active" | "expired" | "revoked";
}

export interface ScopeGroupDef {
  feature: string;
  label: string;
  description: string;
  hasRead: boolean;
  hasWrite: boolean;
  /** choosing read / write for this feature requires a business */
  businessRead?: boolean;
  businessWrite?: boolean;
}

const EXPIRY_CHOICES = [
  { value: "1d", label: "1 day" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "1y", label: "1 year" },
  { value: "never", label: "No expiration" },
] as const;

const dateFmt = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });

function relative(iso: string, now = Date.now()): string {
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  const units: [number, string][] = [[60, "minute"], [3600, "hour"], [86_400, "day"], [2_592_000, "month"], [31_536_000, "year"]];
  let out = "just now";
  for (let i = 0; i < units.length; i++) {
    const [size, name] = units[i]!;
    if (s >= size) { const n = Math.floor(s / size); out = `${n} ${name}${n === 1 ? "" : "s"} ago`; }
  }
  return out;
}

const STATUS_TONE = { active: "success", expired: "warning", revoked: "danger" } as const;

function RevokeButton({ id, name, action }: { id: string; name: string; action: (prev: TokenActionState, fd: FormData) => Promise<TokenActionState> }) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState(action, null);
  if (!confirming) {
    return <Button variant="outline" size="sm" onClick={() => setConfirming(true)} aria-label={`Revoke ${name}`}>Revoke</Button>;
  }
  return (
    <form action={formAction} className="flex flex-col items-end gap-1" role="group" aria-label={`Confirm revoking ${name}`}>
      <input type="hidden" name="id" value={id} />
      <p className="text-xs text-danger">Apps using this key stop working immediately.</p>
      <div className="flex gap-2">
        <Button type="submit" variant="danger" size="sm" disabled={pending}>{pending ? "Revoking…" : "Yes, revoke"}</Button>
        <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={pending}>Cancel</Button>
      </div>
      {state && !state.ok ? <p role="alert" className="text-xs text-danger">{state.error}</p> : null}
    </form>
  );
}

/** Table of the person's keys. `revokeAction` receives FormData with `id`. Omit to hide the revoke column. */
export function ApiKeysTable({
  keys,
  revokeAction,
  emptyMessage = "No API keys yet.",
  className,
}: {
  keys: ApiKeyRow[];
  revokeAction?: (prev: TokenActionState, fd: FormData) => Promise<TokenActionState>;
  emptyMessage?: string;
  className?: string;
}) {
  if (keys.length === 0) return <p className="rounded-card border border-dashed border-line px-4 py-8 text-center text-sm text-muted">{emptyMessage}</p>;
  return (
    <div className={cn("overflow-x-auto rounded-card border border-line bg-surface", className)}>
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">API keys</caption>
        <thead>
          <tr className="border-b border-line bg-canvas text-xs uppercase tracking-wide text-muted">
            <th scope="col" className="px-3 py-2 font-semibold">Name</th>
            <th scope="col" className="px-3 py-2 font-semibold">Permissions</th>
            <th scope="col" className="px-3 py-2 font-semibold">Created</th>
            <th scope="col" className="px-3 py-2 font-semibold">Expires</th>
            <th scope="col" className="px-3 py-2 font-semibold">Last used</th>
            <th scope="col" className="px-3 py-2 font-semibold">Status</th>
            {revokeAction ? <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th> : null}
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k.id} className="border-b border-line align-top last:border-b-0">
              <td className="px-3 py-3">
                <p className="font-medium text-ink">{k.name}</p>
                <code className="rounded bg-canvas px-1 py-0.5 font-mono text-xs text-muted">{k.prefix}…</code>
                {k.businessName ? <p className="mt-1 text-xs text-muted">{k.businessName}</p> : null}
              </td>
              <td className="max-w-xs px-3 py-3">
                <ul className="flex flex-wrap gap-1" aria-label="Scopes">
                  {k.scopes.map((s) => <li key={s}><Badge className="font-mono">{s}</Badge></li>)}
                </ul>
              </td>
              <td className="whitespace-nowrap px-3 py-3 text-muted">{dateFmt.format(new Date(k.createdAt))}</td>
              <td className="whitespace-nowrap px-3 py-3">
                {k.expiresAt ? (
                  <span className="inline-flex items-center gap-1.5">
                    {dateFmt.format(new Date(k.expiresAt))}
                    {k.status === "expired" ? <Badge tone="warning">Expired</Badge> : null}
                  </span>
                ) : <span className="text-muted">Never</span>}
              </td>
              <td className="whitespace-nowrap px-3 py-3">
                {k.lastUsedAt ? (
                  <>
                    <span title={new Date(k.lastUsedAt).toISOString()}>{relative(k.lastUsedAt)}</span>
                    {k.lastUsedIp ? <p className="font-mono text-xs text-muted">{k.lastUsedIp}</p> : null}
                  </>
                ) : <span className="text-muted">Never used</span>}
              </td>
              <td className="px-3 py-3"><Badge tone={STATUS_TONE[k.status]}>{k.status[0]!.toUpperCase() + k.status.slice(1)}</Badge></td>
              {revokeAction ? (
                <td className="px-3 py-3 text-right">
                  {k.status === "revoked" ? null : <RevokeButton id={k.id} name={k.name} action={revokeAction} />}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      icon={copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch { /* clipboard unavailable: the value stays selectable */ }
      }}
    >
      <span aria-live="polite">{copied ? "Copied" : label}</span>
    </Button>
  );
}

/** Shows a new secret once, with copy and usage snippets. Render only from the creation response. */
export function SecretReveal({ secret, name, apiBaseUrl, onDone }: { secret: string; name?: string; apiBaseUrl: string; onDone?: () => void }) {
  const base = apiBaseUrl.replace(/\/+$/, "");
  const curl = `curl -H "Authorization: Bearer ${secret}" \\\n  ${base}/v1/me`;
  const mcp = JSON.stringify({ mcpServers: { cnote: { url: `${base}/mcp`, headers: { Authorization: `Bearer ${secret}` } } } }, null, 2);
  return (
    <div className="flex flex-col gap-4">
      <Alert tone="warning">
        <strong>Copy your key now.</strong> You won&apos;t see it again{name ? ` — “${name}” is stored only as a hash` : ""}. Treat it like a password.
      </Alert>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input readOnly value={secret} aria-label="Your new API key" onFocus={(e) => e.currentTarget.select()}
          className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3 font-mono text-sm text-ink" />
        <CopyButton text={secret} label="Copy key" />
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-medium text-ink">Try it with curl</p>
        <pre className="overflow-x-auto rounded-lg border border-line bg-canvas p-3 font-mono text-xs text-ink">{curl}</pre>
        <div><CopyButton text={curl} label="Copy command" /></div>
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-medium text-ink">Connect an MCP client</p>
        <pre className="overflow-x-auto rounded-lg border border-line bg-canvas p-3 font-mono text-xs text-ink">{mcp}</pre>
        <div><CopyButton text={mcp} label="Copy config" /></div>
      </div>
      {onDone ? <Button onClick={onDone} className="self-start">I&apos;ve saved my key</Button> : null}
    </div>
  );
}

type Level = "none" | "read" | "write";

/**
 * Create-key form. `action` gets FormData: `name`, `expiry`, `businessId`, and one `access_<feature>`
 * ("none" | "read" | "write") per group; it returns `{ ok: true, data: { secret } }` on success.
 */
export function CreateApiKeyForm({
  action,
  groups,
  businesses,
  apiBaseUrl,
}: {
  action: (prev: TokenActionState<{ secret: string; name: string }>, fd: FormData) => Promise<TokenActionState<{ secret: string; name: string }>>;
  groups: ScopeGroupDef[];
  businesses: { id: string; name: string }[];
  apiBaseUrl: string;
}) {
  const uid = useId();
  const [state, formAction, pending] = useActionState(action, null);
  const [dismissed, setDismissed] = useState<unknown>(null);
  const [formKey, setFormKey] = useState(0);
  const [levels, setLevels] = useState<Record<string, Level>>({});
  const [expiry, setExpiry] = useState("30d");

  if (state?.ok && state !== dismissed) {
    return <SecretReveal secret={state.data.secret} name={state.data.name} apiBaseUrl={apiBaseUrl}
      onDone={() => { setDismissed(state); setFormKey((k) => k + 1); setLevels({}); }} />;
  }

  const needsBusiness = groups.some((g) => {
    const l = levels[g.feature] ?? "none";
    return (l === "read" && g.businessRead) || (l === "write" && (g.businessWrite ?? false));
  });
  const fe = (k: string) => (state && !state.ok ? state.fieldErrors?.[k] : undefined);

  return (
    <form key={formKey} action={formAction} className="flex flex-col gap-5" noValidate>
      {state && !state.ok && !state.fieldErrors ? <Alert tone="danger">{state.error}</Alert> : null}
      <Field label="Name" htmlFor={`${uid}-name`} hint="For example “Inventory sync”. Up to 60 characters." error={fe("name")}>
        <Input id={`${uid}-name`} name="name" maxLength={60} required autoComplete="off" />
      </Field>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-ink">Permissions</legend>
        <p className="text-xs text-muted">Choose what this key may do. Read &amp; write includes read.</p>
        {fe("scopes") ? <p role="alert" className="text-xs text-danger">{fe("scopes")}</p> : null}
        <div className="divide-y divide-line rounded-card border border-line bg-surface">
          {groups.map((g) => {
            const level = levels[g.feature] ?? "none";
            const opts: { v: Level; label: string; show: boolean }[] = [
              { v: "none", label: "None", show: true },
              { v: "read", label: "Read", show: g.hasRead },
              { v: "write", label: "Read & write", show: g.hasWrite },
            ];
            return (
              <fieldset key={g.feature} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <legend className="sr-only">{g.label} access</legend>
                <div>
                  <p className="text-sm font-medium text-ink" aria-hidden>{g.label}</p>
                  <p className="text-xs text-muted">{g.description}</p>
                </div>
                <div className="flex gap-1" role="presentation">
                  {opts.filter((o) => o.show).map((o) => (
                    <label key={o.v} className={cn(
                      "inline-flex min-h-9 cursor-pointer items-center rounded-full border px-3 text-xs font-medium transition-colors",
                      "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-600",
                      level === o.v ? "border-brand-600 bg-brand-50 text-brand-700" : "border-line bg-surface text-ink hover:bg-canvas",
                    )}>
                      <input type="radio" className="sr-only" name={`access_${g.feature}`} value={o.v} checked={level === o.v}
                        onChange={() => setLevels((p) => ({ ...p, [g.feature]: o.v }))} />
                      {o.label}
                    </label>
                  ))}
                </div>
              </fieldset>
            );
          })}
        </div>
      </fieldset>

      {needsBusiness || businesses.length > 0 ? (
        <Field label="Business" htmlFor={`${uid}-biz`} error={fe("businessId")}
          hint={needsBusiness ? "Required: the key acts on behalf of this business." : "Optional for the permissions you picked."}>
          <Select id={`${uid}-biz`} name="businessId" required={needsBusiness} defaultValue={businesses.length === 1 ? businesses[0]!.id : ""}>
            {needsBusiness ? <option value="" disabled>Select a business</option> : <option value="">No business (person-level)</option>}
            {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </Field>
      ) : null}

      <Field label="Expiration" htmlFor={`${uid}-exp`} error={fe("expiry")}>
        <Select id={`${uid}-exp`} name="expiry" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
          {EXPIRY_CHOICES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
      </Field>
      {expiry === "never" ? (
        <Alert tone="warning">A key that never expires stays valid until you revoke it. Prefer a short expiry and rotate keys regularly.</Alert>
      ) : null}

      <Button type="submit" disabled={pending} className="self-start">{pending ? "Creating…" : "Create API key"}</Button>
    </form>
  );
}
