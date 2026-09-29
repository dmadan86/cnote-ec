import "@/features/templates/registry";
import { hasPrivilege } from "@cnote/admin";
import { getTemplate, listLayouts } from "@cnote/templates";
import { Alert, Badge, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Mono, Table, Td, Th } from "@/components/table";
import { AddLocale, EnabledToggle, LayoutSelect } from "@/features/templates/controls";
import { TemplateEditor } from "@/features/templates/template-editor";
import { requireStaff } from "@/lib/auth";
import { safe } from "@/lib/util";

export const metadata = { title: "Edit template" };

export default async function TemplatePage({ params }: PageProps<"/templates/[id]">) {
  const { id } = await params;
  const { staff } = await requireStaff(`/templates/${id}`, "templates.read");
  if (!z.uuid().safeParse(id).success) notFound();
  const t = await safe("templates.getTemplate", () => getTemplate(id));
  if (t === null) return (<><PageHeader title="Template" /><Alert tone="warning">This template is currently unavailable.</Alert></>);
  if (!t) notFound();
  const canManage = hasPrivilege(staff, "templates.manage");
  const canPublish = hasPrivilege(staff, "templates.publish");
  const layouts = t.template.channel === "email" ? ((await safe("templates.listLayouts", () => listLayouts())) ?? []) : [];
  const vars = t.definition?.variables ?? [];
  return (
    <>
      <PageHeader
        title={t.template.name}
        description={<><Mono>{t.template.key}</Mono> · {t.template.channel} · {t.template.locale}{t.definition ? ` · ${t.definition.category}` : ""}</>}
        actions={<Link href="/templates" className="text-sm font-medium text-brand-700 hover:underline">← All templates</Link>}
      />
      {!t.definition ? <Alert tone="warning">This key is no longer registered in code, so no variables are known and test sends are unavailable.</Alert> : t.definition.description ? <p className="text-sm text-muted">{t.definition.description}</p> : null}
      {!t.published ? <Alert tone="warning">No version is published for this language yet, so messages fall back to English, then to the built-in default.</Alert> : null}

      <div className="flex flex-wrap items-end gap-6">
        <div className="flex flex-col gap-1.5"><span className="text-sm font-medium">Sending</span><EnabledToggle templateId={t.template.id} enabled={t.template.enabled} disabled={!canManage} label={t.template.name} /></div>
        {t.template.channel === "email" && layouts.length ? <LayoutSelect templateId={t.template.id} layoutId={t.template.layoutId} layouts={layouts} disabled={!canManage} /> : null}
        {canManage && t.definition ? <AddLocale templateKey={t.template.key} channel={t.template.channel} /> : null}
      </div>

      <TemplateEditor
        key={`${t.draft?.id ?? "nodraft"}|${t.published?.id ?? "nopub"}`}
        templateId={t.template.id}
        channel={t.template.channel}
        variables={vars.map((v) => ({ name: v.name, description: v.description, example: v.example, required: v.required }))}
        versions={t.versions}
        draft={t.draft}
        published={t.published}
        draftToken={t.draftToken}
        canManage={canManage}
        canPublish={canPublish}
      />

      {vars.length ? (
        <details className="rounded-card border border-line bg-surface p-3">
          <summary className="cursor-pointer text-sm font-semibold">Variables available in this template</summary>
          <div className="mt-3">
            <Table>
              <thead><tr><Th>Variable</Th><Th>Description</Th><Th>Example</Th><Th /></tr></thead>
              <tbody>
                {vars.map((v) => (
                  <tr key={v.name}>
                    <Td><Mono>{`{{${v.name}}}`}</Mono></Td><Td>{v.description}</Td><Td>{v.example}</Td><Td>{v.required ? <Badge tone="warning">required</Badge> : null}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="mt-2 text-xs text-muted">Values are HTML-escaped. Use <Mono>{"{{#name}}…{{/name}}"}</Mono> to show something only when a variable has a value. Layouts can also use {"{{brand.name}}"}, {"{{brand.address}}"}, {"{{brand.supportEmail}}"}.</p>
          </div>
        </details>
      ) : null}
    </>
  );
}
