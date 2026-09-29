import "@/features/templates/registry";
import { hasPrivilege } from "@cnote/admin";
import { FONT_FAMILIES, getLayout } from "@cnote/templates";
import { Alert, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Mono } from "@/components/table";
import { LayoutEditor } from "@/features/templates/layout-editor";
import { requireStaff } from "@/lib/auth";
import { safe } from "@/lib/util";

export const metadata = { title: "Edit layout" };

export default async function LayoutPage({ params }: PageProps<"/templates/layouts/[id]">) {
  const { id } = await params;
  const { staff } = await requireStaff(`/templates/layouts/${id}`, "templates.read");
  if (!z.uuid().safeParse(id).success) notFound();
  const l = await safe("templates.getLayout", () => getLayout(id));
  if (l === null) return (<><PageHeader title="Layout" /><Alert tone="warning">This layout is currently unavailable.</Alert></>);
  if (!l) notFound();
  return (
    <>
      <PageHeader
        title={`${l.layout.name} layout`}
        description={<>Header, footer and brand theme wrapped around every email that uses <Mono>{l.layout.key}</Mono>.</>}
        actions={<Link href="/templates" className="text-sm font-medium text-brand-700 hover:underline">← All templates</Link>}
      />
      <LayoutEditor
        key={`${l.draft?.id ?? "nodraft"}|${l.published?.id ?? "nopub"}`}
        layoutId={l.layout.id}
        versions={l.versions}
        draft={l.draft}
        published={l.published}
        draftToken={l.draftToken}
        fonts={FONT_FAMILIES}
        canManage={hasPrivilege(staff, "templates.manage")}
        canPublish={hasPrivilege(staff, "templates.publish")}
      />
    </>
  );
}
