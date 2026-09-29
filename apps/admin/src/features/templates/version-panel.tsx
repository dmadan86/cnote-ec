"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Badge, Button } from "@cnote/ui";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { fmtWhen } from "./shared";

export interface VersionItem {
  id: string;
  version: number;
  status: "draft" | "published" | "archived";
  changeNote: string | null;
  createdBy: string | null;
  createdAt: string;
  publishedAt: string | null;
  /** serialised content used for the side-by-side view */
  content: string;
}

const TONE = { draft: "warning", published: "success", archived: "neutral" } as const;

function lines(s: string): string[] {
  // one HTML tag boundary per line makes rich-text diffs readable
  return s.replace(/></g, ">\n<").split("\n");
}

function Side({ title, text, other }: { title: string; text: string; other: Set<string> }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs font-semibold text-muted">{title}</p>
      <pre className="max-h-72 overflow-auto rounded-lg border border-line bg-canvas p-2 text-[11px] leading-relaxed whitespace-pre-wrap break-words">
        {lines(text).map((l, i) => (
          <span key={i} className={other.has(l) ? "block" : "block bg-amber-100"}>{l || " "}</span>
        ))}
      </pre>
    </div>
  );
}

/** Version history: author/date/note, a side-by-side "both versions" view (differing lines highlighted), start-from and rollback. */
export function VersionPanel({
  versions, compareWith, canManage, canPublish, onStartFrom, onRollback, busy,
}: {
  versions: VersionItem[];
  /** what to compare against: the open draft, else the published version */
  compareWith: VersionItem | null;
  canManage: boolean;
  canPublish: boolean;
  onStartFrom: (versionId: string) => Promise<ActionResult<unknown>>;
  onRollback: (versionId: string) => Promise<ActionResult<unknown>>;
  busy?: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "danger" | "success"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const sel = versions.find((v) => v.id === selected) ?? null;
  const cmp = compareWith && sel && compareWith.id !== sel.id ? compareWith : null;
  const selSet = useMemo(() => new Set(sel ? lines(sel.content) : []), [sel]);
  const cmpSet = useMemo(() => new Set(cmp ? lines(cmp.content) : []), [cmp]);

  function run(fn: () => Promise<ActionResult<unknown>>, ok: string) {
    setMsg(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) setMsg({ tone: "danger", text: r.error });
      else { setMsg({ tone: "success", text: ok }); router.refresh(); }
    });
  }

  return (
    <section aria-labelledby="versions-h" className="space-y-3">
      <h2 id="versions-h" className="text-sm font-semibold uppercase tracking-wide text-muted">Versions</h2>
      <ol className="divide-y divide-line rounded-card border border-line bg-surface">
        {versions.map((v) => (
          <li key={v.id} className="p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold">v{v.version}</span>
              <Badge tone={TONE[v.status]}>{v.status}</Badge>
            </div>
            <p className="mt-0.5 text-xs text-muted">
              {v.publishedAt ? `Published ${fmtWhen(v.publishedAt)}` : `Created ${fmtWhen(v.createdAt)}`}
              {v.createdBy ? ` · by ${v.createdBy.slice(0, 8)}` : ""}
            </p>
            {v.changeNote ? <p className="mt-1 text-xs">{v.changeNote}</p> : null}
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Button size="sm" variant="outline" aria-expanded={selected === v.id} onClick={() => setSelected(selected === v.id ? null : v.id)}>
                {selected === v.id ? "Hide" : "View"}
              </Button>
              {canManage && v.status !== "draft" ? (
                <Button size="sm" variant="ghost" disabled={pending || busy} onClick={() => run(() => onStartFrom(v.id), "Draft created.")}>Edit from this</Button>
              ) : null}
              {canPublish && v.status === "archived" ? (
                <Button size="sm" variant="ghost" disabled={pending || busy} onClick={() => { if (window.confirm(`Roll back to v${v.version}? It will be published as a new version and go live immediately.`)) run(() => onRollback(v.id), `Rolled back to v${v.version}.`); }}>
                  Rollback
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      {msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null}
      {sel ? (
        <div className="grid gap-3 lg:grid-cols-1" aria-live="polite">
          <Side title={`v${sel.version} (${sel.status})`} text={sel.content} other={cmpSet} />
          {cmp ? <Side title={`v${cmp.version} (${cmp.status}) — current`} text={cmp.content} other={selSet} /> : <p className="text-xs text-muted">This is the current version.</p>}
        </div>
      ) : null}
    </section>
  );
}
