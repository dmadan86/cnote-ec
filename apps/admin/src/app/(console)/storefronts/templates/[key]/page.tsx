import { blankDocument, getTemplate } from "@cnote/storefront";
import { PageHeader } from "@cnote/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { TemplateEditor } from "@/features/storefronts/controls";
import { requireStaff } from "@/lib/auth";

export const metadata = { title: "Edit storefront template" };

export default async function EditTemplate(props: { params: Promise<{ key: string }> }) {
  const { key } = await props.params;
  await requireStaff(`/storefronts/templates/${key}`, "storefronts.templates");
  const isNew = key === "new";
  const tpl = isNew ? null : await getTemplate(key).catch(() => null);
  if (!isNew && !tpl) notFound();
  const doc = tpl?.document ?? blankDocument({ name: "{{name}}", city: "{{city}}" });
  return (
    <>
      <PageHeader title={isNew ? "New storefront template" : `Edit: ${tpl!.name}`} actions={<Link href="/storefronts/templates" className="text-sm font-medium text-brand-700 hover:underline">All templates</Link>} />
      <TemplateEditor
        initial={{
          key: tpl?.key ?? "", name: tpl?.name ?? "", description: tpl?.description ?? "", verticals: tpl?.verticals.join(", ") ?? "", tags: tpl?.tags.join(", ") ?? "",
          sortOrder: tpl?.sortOrder ?? 100, active: tpl?.active ?? false, document: JSON.stringify(doc, null, 2), isNew,
        }}
      />
    </>
  );
}
