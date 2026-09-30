import { listMyGrievances } from "@cnote/compliance";
import { requireSession } from "@cnote/next-kit";
import { Alert, Badge, buttonClasses, Card, CardBody, Container, EmptyState, PageHeader } from "@cnote/ui";
import Link from "next/link";

export const metadata = { title: "Your grievances" };

const fmt = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });
const STATUS = { open: ["Received", "neutral"], in_progress: ["In progress", "brand"], resolved: ["Resolved", "success"], rejected: ["Closed without action", "warning"] } as const;

export default async function MyGrievancesPage() {
  const s = await requireSession("/account/grievances");
  const items = await listMyGrievances(s.personId).catch((err) => {
    console.error("[grievance] list failed", err);
    return null;
  });
  return (
    <Container className="flex flex-col gap-6 py-8">
      <PageHeader title="Your grievances" description="Status of the grievances you have raised." actions={<Link href="/grievance" className={buttonClasses("outline", "md")}>Raise a grievance</Link>} />
      {!items ? (
        <Alert tone="danger">We could not load your grievances right now. Please try again in a moment.</Alert>
      ) : items.length === 0 ? (
        <EmptyState title="No grievances yet" description="If you have a concern about your data or content, raise it and we will respond within the statutory window." />
      ) : (
        <ul className="flex flex-col gap-4">
          {items.map((g) => {
            const [label, tone] = STATUS[g.status];
            return (
              <li key={g.id}>
                <Card>
                  <CardBody className="flex flex-col gap-2 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h2 className="text-base font-semibold text-ink">{g.subject}</h2>
                      <Badge tone={tone}>{label}</Badge>
                    </div>
                    <p className="text-muted">
                      Filed {fmt.format(new Date(g.createdAt))} · Reference <code className="break-all">{g.id}</code>
                      {g.status === "open" || g.status === "in_progress" ? ` · We will respond by ${fmt.format(new Date(g.dueAt))}` : null}
                    </p>
                    <p className="whitespace-pre-wrap text-ink">{g.body}</p>
                    {g.resolution ? (
                      <div className="rounded-lg border border-line bg-canvas p-3">
                        <p className="font-medium text-ink">Response from our Grievance Officer</p>
                        <p className="mt-1 whitespace-pre-wrap">{g.resolution}</p>
                      </div>
                    ) : null}
                  </CardBody>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </Container>
  );
}
