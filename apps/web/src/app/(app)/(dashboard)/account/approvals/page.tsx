import { listDelegations, listPolicies, listSpend } from "@cnote/approvals";
import { can, getMemberRole, listBusinessMembers } from "@cnote/identity";
import { requireBusiness } from "@cnote/next-kit";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Container, PageHeader, buttonClasses } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { deletePolicyAction, revokeDelegationAction, togglePolicyAction } from "@/features/approvals/actions";
import { DelegationForm, SpendLimitForm } from "@/features/approvals/forms";
import { EditablePolicy, NewPolicy } from "@/features/approvals/policy-list";
import { personNames, rupees } from "@/features/approvals/trail";
import { formatDate } from "@/i18n/config";
import { getRequestLocale } from "@/lib/request-locale";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "approvals" });
  return { title: t("rules.title") };
}

const toRupees = (paise: number) => (paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2));

export default async function ApprovalRulesPage() {
  const s = await requireBusiness("/account/approvals");
  const role = await getMemberRole(s.personId, s.business.id);
  if (!role) notFound();
  const locale = await getRequestLocale();
  const t = await getTranslations({ locale, namespace: "approvals" });
  const managePolicy = can(role, "policy.manage");
  const manageSpend = can(role, "spend.manage");
  const canDecide = can(role, "approvals.decide");
  const [policies, delegations, spend, members] = await Promise.all([
    listPolicies(s.business.id),
    listDelegations(s.business.id),
    listSpend(s.business.id),
    listBusinessMembers(s.business.id),
  ]);
  const names = await personNames(members.map((m) => m.personId));
  const nm = (id: string) => names.get(id) ?? "—";
  const memberOptions = members.map((m) => ({ personId: m.personId, label: nm(m.personId) }));
  const when = (iso: string) => formatDate(iso, locale, { dateStyle: "medium" });
  const mine = delegations.filter((d) => d.delegatorPersonId === s.personId || managePolicy);

  return (
    <Container className="flex flex-col gap-6 py-8">
      <PageHeader
        title={t("rules.title")}
        description={t("rules.description")}
        actions={<><Link href="/buyer/approvals" className={buttonClasses("outline")}>{t("inbox.title")}</Link><Link href="/account/team" className={buttonClasses("outline")}>{t("team.title")}</Link></>}
      />

      <Card>
        <CardHeader><CardTitle>{t("rules.listTitle")}</CardTitle></CardHeader>
        <CardBody className="flex flex-col gap-4">
          {policies.length === 0 ? <p className="text-sm text-muted">{t("rules.empty")}</p> : null}
          <ul className="flex flex-col gap-3">
            {policies.map((p) => (
              <li key={p.id} className="rounded-lg border border-line p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="font-semibold text-ink">{p.name} {p.enabled ? <Badge tone="success">{t("rules.on")}</Badge> : <Badge>{t("rules.off")}</Badge>}</h3>
                    <p className="mt-1 text-sm text-muted">{t("rules.summary", { action: t(`actions.${p.action}`), amount: rupees(p.minAmountPaise) })}</p>
                  </div>
                  {managePolicy ? (
                    <div className="flex flex-wrap gap-2">
                      <form action={togglePolicyAction}>
                        <input type="hidden" name="id" value={p.id} />
                        <input type="hidden" name="enabled" value={String(!p.enabled)} />
                        <Button type="submit" variant="outline" size="sm" aria-label={`${p.enabled ? t("rules.turnOff") : t("rules.turnOn")}: ${p.name}`}>{p.enabled ? t("rules.turnOff") : t("rules.turnOn")}</Button>
                      </form>
                      <form action={deletePolicyAction}>
                        <input type="hidden" name="id" value={p.id} />
                        <Button type="submit" variant="ghost" size="sm" aria-label={`${t("rules.delete")}: ${p.name}`}>{t("rules.delete")}</Button>
                      </form>
                    </div>
                  ) : null}
                </div>
                <ol className="mt-3 flex flex-col gap-1 text-sm text-ink">
                  {p.levels.map((l) => (
                    <li key={l.level}>
                      {t("rules.levelLine", { n: l.level, who: l.personIds.length ? l.personIds.map(nm).join(", ") : t(`roles.${l.role}`) })}
                      {l.minAmountPaise > 0 ? <span className="text-muted"> · {t("rules.levelFrom", { amount: rupees(l.minAmountPaise) })}</span> : null}
                    </li>
                  ))}
                </ol>
                {managePolicy ? (
                  <EditablePolicy
                    members={memberOptions}
                    initial={{ id: p.id, name: p.name, action: p.action, thresholdRupees: toRupees(p.minAmountPaise), levels: p.levels.map((l) => ({ role: l.role, personIds: l.personIds, minRupees: toRupees(l.minAmountPaise) })) }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
          {managePolicy ? <NewPolicy members={memberOptions} /> : <p className="text-sm text-muted">{t("rules.readOnly")}</p>}
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t("delegation.title")}</CardTitle></CardHeader>
        <CardBody className="flex flex-col gap-4">
          <p className="text-sm text-muted">{t("delegation.description")}</p>
          {mine.length ? (
            <ul className="divide-y divide-line">
              {mine.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
                  <span className="text-ink">{t("delegation.line", { from: nm(d.delegatorPersonId), to: nm(d.delegatePersonId), start: when(d.startsAt), end: when(d.endsAt) })} {d.active ? <Badge tone="success">{t("delegation.active")}</Badge> : null}</span>
                  <form action={revokeDelegationAction}>
                    <input type="hidden" name="id" value={d.id} />
                    <Button type="submit" variant="outline" size="sm" aria-label={t("delegation.endFor", { to: nm(d.delegatePersonId) })}>{t("delegation.end")}</Button>
                  </form>
                </li>
              ))}
            </ul>
          ) : null}
          {canDecide ? <DelegationForm members={memberOptions.filter((m) => m.personId !== s.personId)} /> : <p className="text-sm text-muted">{t("delegation.onlyApprovers")}</p>}
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t("spend.title")}</CardTitle></CardHeader>
        <CardBody className="flex flex-col gap-4">
          <p className="text-sm text-muted">{t("spend.description")}</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-sm">
              <caption className="sr-only">{t("spend.title")}</caption>
              <thead>
                <tr className="border-b border-line text-start text-muted">
                  <th scope="col" className="py-2 pe-3 text-start font-medium">{t("spend.member")}</th>
                  <th scope="col" className="py-2 pe-3 text-start font-medium">{t("spend.spent")}</th>
                  <th scope="col" className="py-2 text-start font-medium">{t("spend.cap")}</th>
                </tr>
              </thead>
              <tbody>
                {spend.map((x) => (
                  <tr key={x.personId} className="border-b border-line align-top">
                    <th scope="row" className="py-2 pe-3 text-start font-medium text-ink">{nm(x.personId)} <span className="font-normal text-muted">· {t(`roles.${x.role}`)}</span></th>
                    <td className="py-2 pe-3 text-ink">{rupees(x.spentPaise)}</td>
                    <td className="py-2">
                      {manageSpend ? <SpendLimitForm personId={x.personId} name={nm(x.personId)} capRupees={x.capPaise === null ? "" : toRupees(x.capPaise)} /> : x.capPaise === null ? t("spend.noLimit") : rupees(x.capPaise)}
                      {x.capPaise !== null && x.spentPaise > x.capPaise ? <Badge tone="warning" className="mt-1">{t("spend.over")}</Badge> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted">{t("spend.note")}</p>
        </CardBody>
      </Card>
    </Container>
  );
}
