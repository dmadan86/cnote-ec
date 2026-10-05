import { can, getTeam } from "@cnote/identity";
import { requireBusiness } from "@cnote/next-kit";
import { Badge, Card, CardBody, CardHeader, CardTitle, Container, PageHeader, buttonClasses } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { InviteForm, MemberControls, TransferOwnershipForm } from "@/features/approvals/forms";
import { revokeInviteAction } from "@/features/approvals/actions";
import { Button } from "@cnote/ui";
import { formatDate } from "@/i18n/config";
import { getRequestLocale } from "@/lib/request-locale";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "approvals" });
  return { title: t("team.title") };
}

export default async function TeamPage() {
  const s = await requireBusiness("/account/team");
  const locale = await getRequestLocale();
  const t = await getTranslations({ locale, namespace: "approvals" });
  const team = await getTeam(s.personId, s.business.id);
  if (!team) notFound();
  const manage = can(team.myRole, "team.manage");
  const owner = team.myRole === "owner";
  const label = (m: { name: string | null; email: string | null }) => m.name ?? m.email ?? "—";
  const when = (iso: string) => formatDate(iso, locale, { dateStyle: "medium" });

  return (
    <Container className="flex flex-col gap-6 py-8">
      <PageHeader
        title={t("team.title")}
        description={t("team.description", { business: s.business.name })}
        actions={<Link href="/account/approvals" className={buttonClasses("outline")}>{t("team.rulesLink")}</Link>}
      />

      {manage ? (
        <Card>
          <CardHeader><CardTitle>{t("team.inviteTitle")}</CardTitle></CardHeader>
          <CardBody><InviteForm canInviteAdmin={owner} /></CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader><CardTitle>{t("team.membersTitle", { count: team.members.length })}</CardTitle></CardHeader>
        <CardBody>
          <ul className="divide-y divide-line">
            {team.members.map((m) => {
              const isSelf = m.personId === s.personId;
              const editable = manage && m.role !== "owner" && !(isSelf && !owner) && (owner || m.role !== "admin");
              return (
                <li key={m.personId} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-medium text-ink">
                      {label(m)} {isSelf ? <Badge tone="brand">{t("team.you")}</Badge> : null}
                    </p>
                    {m.name && m.email ? <p className="truncate text-sm text-muted">{m.email}</p> : null}
                  </div>
                  <MemberControls
                    personId={m.personId}
                    name={label(m)}
                    role={m.role}
                    storedRole={m.storedRole}
                    canEditRole={editable}
                    canRemove={m.role !== "owner" && (isSelf || (manage && (owner || m.role !== "admin")))}
                    canInviteAdmin={owner}
                    isSelf={isSelf}
                  />
                </li>
              );
            })}
          </ul>
          <p className="mt-4 text-sm text-muted">{t("team.rolesHelp")}</p>
        </CardBody>
      </Card>

      {manage ? (
        <Card>
          <CardHeader><CardTitle>{t("team.pendingTitle")}</CardTitle></CardHeader>
          <CardBody>
            {team.invites.length === 0 ? (
              <p className="text-sm text-muted">{t("team.pendingEmpty")}</p>
            ) : (
              <ul className="divide-y divide-line">
                {team.invites.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-ink">{i.email}</p>
                      <p className="text-sm text-muted">{t(`roles.${i.role}`)} · {i.status === "expired" ? t("team.expired", { date: when(i.expiresAt) }) : t("team.expires", { date: when(i.expiresAt) })}</p>
                    </div>
                    <form action={revokeInviteAction}>
                      <input type="hidden" name="inviteId" value={i.id} />
                      <Button type="submit" variant="outline" size="sm" aria-label={t("team.revokeFor", { email: i.email })}>{t("team.revoke")}</Button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      ) : null}

      {owner ? (
        <Card>
          <CardHeader><CardTitle>{t("team.transferTitle")}</CardTitle></CardHeader>
          <CardBody>
            <TransferOwnershipForm members={team.members.filter((m) => m.personId !== s.personId).map((m) => ({ personId: m.personId, label: label(m) }))} />
          </CardBody>
        </Card>
      ) : null}
    </Container>
  );
}
