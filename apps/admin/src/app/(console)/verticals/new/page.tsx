import { listCandidateRoots } from "@cnote/verticals";
import { Card, CardBody, PageHeader } from "@cnote/ui";
import { requireStaff } from "@/lib/auth";
import { safe } from "@/lib/util";
import { CreateVerticalForm } from "../forms";

export const metadata = { title: "New vertical" };

export default async function NewVerticalPage() {
  await requireStaff("/verticals/new", "verticals.manage");
  const roots = (await safe("verticals.roots", () => listCandidateRoots())) ?? [];
  return (
    <>
      <PageHeader title="New vertical" description="Creates a candidate and seeds the Phase-1 playbook checklist (ADR-016). Which vertical launches first is an open decision (ADR-011): nothing here presumes one." />
      {roots.length ? <p className="text-sm text-muted">Root categories: {roots.map((r) => `${r.slug} (${r.children})`).join(", ")}</p> : null}
      <Card><CardBody><CreateVerticalForm /></CardBody></Card>
    </>
  );
}
