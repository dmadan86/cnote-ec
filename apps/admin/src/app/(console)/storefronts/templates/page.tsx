import { listTemplates } from "@cnote/storefront";
import { Alert, Badge, buttonClasses, EmptyState, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { Mono, Table, Td, Th } from "@/components/table";
import { SeedTemplatesForm, TemplateRowControls } from "@/features/storefronts/controls";
import { requireStaff } from "@/lib/auth";
import { fmtDate, safe } from "@/lib/util";

export const metadata = { title: "Storefront templates" };

export default async function StorefrontTemplatesPage() {
  await requireStaff("/storefronts/templates", "storefronts.templates");
  const list = await safe("storefront.listTemplates", () => listTemplates({ includeInactive: true }));
  if (list === null) return (<><PageHeader title="Storefront templates" /><Alert tone="warning">Templates are currently unavailable.</Alert></>);
  const keys = list.map((t) => t.key);
  return (
    <>
      <PageHeader
        title="Storefront templates"
        description="The Studio gallery sellers pick from. Each template is a validated storefront document with placeholder content; colours are checked for WCAG AA. Deactivating hides a template from new sellers only."
        actions={<div className="flex items-start gap-3"><Link href="/storefronts/templates/new" className={buttonClasses("primary")}>New template</Link><SeedTemplatesForm /></div>}
      />
      {list.length === 0 ? <EmptyState title="No templates yet" description="Seed the six built-in templates, or create your own." /> : (
        <Table>
          <thead><tr><Th>Template</Th><Th>Verticals</Th><Th>Tags</Th><Th>Updated</Th><Th>Gallery</Th></tr></thead>
          <tbody>
            {list.map((t, i) => (
              <tr key={t.key}>
                <Td><Link href={`/storefronts/templates/${t.key}`} className="font-medium text-brand-700 hover:underline">{t.name}</Link><div><Mono>{t.key}</Mono></div></Td>
                <Td>{t.verticals.length ? t.verticals.join(", ") : <Badge tone="neutral">any</Badge>}</Td>
                <Td>{t.tags.join(", ")}</Td>
                <Td className="whitespace-nowrap">{fmtDate(t.updatedAt)}</Td>
                <Td><TemplateRowControls tplKey={t.key} active={t.active} index={i} keys={keys} /></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
