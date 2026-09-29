import "@/features/templates/registry";
import { hasPrivilege } from "@cnote/admin";
import { listLayouts, listTemplateAssets, listTemplates } from "@cnote/templates";
import { Alert, Badge, EmptyState, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { Mono, Table, Td, Th } from "@/components/table";
import { DeleteAssetButton, EnabledToggle, SeedButton } from "@/features/templates/controls";
import { requireStaff } from "@/lib/auth";
import { fmtDate, safe } from "@/lib/util";

export const metadata = { title: "Templates" };

const CATEGORY_TONE = { transactional: "neutral", security: "warning", marketing: "brand" } as const;

export default async function TemplatesPage() {
  const { staff } = await requireStaff("/templates", "templates.read");
  const canManage = hasPrivilege(staff, "templates.manage");
  const [groups, layouts, assets] = await Promise.all([
    safe("templates.listTemplates", () => listTemplates()),
    safe("templates.listLayouts", () => listLayouts()),
    safe("templates.listTemplateAssets", () => listTemplateAssets(60)),
  ]);
  if (groups === null) return (<><PageHeader title="Templates" /><Alert tone="warning">Templates are currently unavailable.</Alert></>);
  const missing = groups.reduce((n, g) => n + g.missingChannels.length, 0);
  return (
    <>
      <PageHeader
        title="Templates"
        description="Email and notification content lives here, not in code. Edit a draft, preview it, then publish. Changes apply to messages sent afterwards, including ones already queued."
        actions={canManage && (missing > 0 || layouts?.length === 0) ? <SeedButton /> : undefined}
      />
      {missing > 0 ? <Alert tone="info">{missing} template channel(s) registered in code have no content yet. Until you create them, the built-in defaults are sent.</Alert> : null}

      <section aria-labelledby="tpl-h" className="space-y-3">
        <h2 id="tpl-h" className="text-sm font-semibold uppercase tracking-wide text-muted">Templates</h2>
        {groups.length === 0 ? <EmptyState title="No templates registered" description="Modules register their template keys in code with defineTemplates()." /> : (
          <Table>
            <thead><tr><Th>Template</Th><Th>Category</Th><Th>Channel</Th><Th>Language</Th><Th>Live version</Th><Th>Enabled</Th><Th>Last edited</Th></tr></thead>
            <tbody>
              {groups.flatMap((g) =>
                g.rows.length === 0
                  ? [(
                    <tr key={g.key}>
                      <Td><p className="font-medium">{g.name}</p><Mono>{g.key}</Mono></Td>
                      <Td>{g.category ? <Badge tone={CATEGORY_TONE[g.category as keyof typeof CATEGORY_TONE]}>{g.category}</Badge> : null}</Td>
                      <Td colSpan={5} className="text-muted">Not created yet (code defaults are used).</Td>
                    </tr>
                  )]
                  : g.rows.map((r, i) => (
                    <tr key={r.id}>
                      <Td>
                        {i === 0 ? (<><p className="font-medium">{g.name}</p><Mono>{g.key}</Mono></>) : null}
                      </Td>
                      <Td>{i === 0 && g.category ? <Badge tone={CATEGORY_TONE[g.category as keyof typeof CATEGORY_TONE]}>{g.category}</Badge> : null}</Td>
                      <Td>{r.channel}</Td>
                      <Td>{r.locale}</Td>
                      <Td>
                        <Link href={`/templates/${r.id}`} className="font-medium text-brand-700 hover:underline">{r.publishedVersion ? `v${r.publishedVersion}` : "unpublished"}</Link>
                        {r.hasDraft ? <Badge tone="warning" className="ml-2">draft</Badge> : null}
                      </Td>
                      <Td><EnabledToggle templateId={r.id} enabled={r.enabled} disabled={!canManage} label={`${g.name} ${r.channel} ${r.locale}`} /></Td>
                      <Td className="whitespace-nowrap">{fmtDate(r.lastEditedAt)}</Td>
                    </tr>
                  )),
              )}
            </tbody>
          </Table>
        )}
      </section>

      <section aria-labelledby="lay-h" className="space-y-3">
        <h2 id="lay-h" className="text-sm font-semibold uppercase tracking-wide text-muted">Email layouts</h2>
        {!layouts || layouts.length === 0 ? <EmptyState title="No layouts yet" description="Create the default layout with “Create missing defaults”." /> : (
          <Table>
            <thead><tr><Th>Layout</Th><Th>Live version</Th><Th>Used by</Th><Th>Last edited</Th></tr></thead>
            <tbody>
              {layouts.map((l) => (
                <tr key={l.id}>
                  <Td><p className="font-medium">{l.name}</p><Mono>{l.key}</Mono></Td>
                  <Td>
                    <Link href={`/templates/layouts/${l.id}`} className="font-medium text-brand-700 hover:underline">{l.publishedVersion ? `v${l.publishedVersion}` : "unpublished"}</Link>
                    {l.hasDraft ? <Badge tone="warning" className="ml-2">draft</Badge> : null}
                  </Td>
                  <Td>{l.key === "default" ? "all templates without their own layout" : `${l.templateCount} template(s)`}</Td>
                  <Td className="whitespace-nowrap">{fmtDate(l.updatedAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <section aria-labelledby="img-h" className="space-y-3">
        <h2 id="img-h" className="text-sm font-semibold uppercase tracking-wide text-muted">Images</h2>
        <p className="text-xs text-muted">Upload images from the editor toolbar. An image can be deleted only when no template or layout version (including old ones) uses it.</p>
        {!assets || assets.length === 0 ? <p className="text-sm text-muted">No images uploaded yet.</p> : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {assets.map((a) => (
              <li key={a.id} className="rounded-card border border-line bg-surface p-2 text-xs">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={a.url} alt={a.altText ?? "Template image"} className="h-24 w-full rounded bg-canvas object-contain" />
                <p className="mt-1 truncate text-muted">{a.width}×{a.height} · {Math.round(a.bytes / 1024)} KB</p>
                <p className="flex items-center gap-1">{a.inUse ? <Badge tone="success">in use</Badge> : <Badge>unused</Badge>}</p>
                {canManage ? <DeleteAssetButton assetId={a.id} inUse={a.inUse} /> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
