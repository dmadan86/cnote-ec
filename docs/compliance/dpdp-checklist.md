# DPDP compliance checklist (status in this codebase)

Status: Done, Partial, Open. Sources are secondary summaries of the DPDP Act 2023 and the DPDP Rules 2025 (notified 13 Nov 2025, G.S.R. 846(E)); have counsel confirm section and rule numbers, and the phased commencement dates, before relying on them. Reference summaries: [MediaNama on breach reporting](https://www.medianama.com/2025/11/223-data-breach-reporting-timeline-of-dpdp-rules-2025-explained/), [EY overview](https://www.ey.com/en_in/insights/cybersecurity/transforming-data-privacy-digital-personal-data-protection-rules-2025), [Seclore guide](https://www.seclore.com/fundamentals/dpdp-rules-2025-compliance-guide/), [Rule 3 text](https://www.dpdpa.com/dpdparules/rule3.html), IT Rules 2021 r.3(2) via [PRS](https://prsindia.org/billtrack/amendments-to-it-rules-2021).

| Duty | Source | Status | Where |
|---|---|---|---|
| Notice before or at consent: personal data, purpose, how to exercise rights and complain | Act s.5, Rule 3 | Partial | Consent UI in `apps/web/src/features/identity` captures purpose-scoped consents; a full itemised notice page is Open |
| Consent: free, specific, informed, unambiguous, withdrawable as easily as given | Act s.6 | Done | `Consent` ledger (append-only), `setConsent`, account privacy form |
| Purpose limitation / data minimisation | Act s.6, s.8 | Partial | PII redaction before AI calls (ADR-008); phone stored as hash pre-verification (leadgen) |
| Reasonable security safeguards | Act s.8(5) | Partial | `docs/security/security-architecture.md`, field encryption, MFA, audit log |
| Breach: notify Board and principals; detailed report in 72 h | Act s.8(6), Rule 7 | Partial | Runbook `breach-response-runbook.md`; no automated detection or notification tooling |
| Retention and erasure when purpose is served | Act s.8(7), Rule 8 | Done | `retention-schedule.md`, `@cnote/compliance` retention framework and `RetentionRun` evidence |
| Erasure notice 48 h before scheduled erasure | Rule 8(2) with Third Schedule | Done, flagged off | `identity.inactive_accounts_erasure` retention policy (`packages/compliance/src/inactivity.ts`): e-mail notice (DB template `account.inactivity_erasure_notice`, en + hi) at least 48 h (default 7 days) before erasure, erasure only if the person did not sign in or use an API key meanwhile. `INACTIVITY_ERASURE_ENABLED` defaults to false until counsel confirms the Third Schedule threshold applies. Other policies erase operational data only and need no notice |
| Retain processing logs at least one year | Rules (reported) | Done | Audit and event logs are never purged |
| Publish Data Protection Officer / contact for questions | Act s.8(9) | Partial | Grievance Officer shown on `/grievance` (`GRIEVANCE_OFFICER_*`); add to footer and privacy policy |
| Grievance redressal | Act s.8(10), Rule 14 (reported 90-day max) | Done | `grievance-process.md`, `/grievance`, admin queue; defaults 24 h ack / 15 d resolve |
| Right to access, correction, erasure | Act s.11-12 | Partial | Access: `exportPersonalData` + `/account/export`; erasure: `erasePerson`; correction: profile edit; grievance route for the rest |
| Right to nominate | Act s.14, Rule 14 | Done | Account page `/account/nominee` (add / change / remove, step-up, fields encrypted with field encryption); public nominee request `/grievance/nominee`; admin queue `/compliance/nominees` (verify against the nomination, complete with an audited action); see `nominee-right.md` |
| Children's data: verifiable parental consent, no tracking | Act s.9 | Open | Product is B2B; age gate not implemented |
| Cross-border transfer restrictions | Act s.16 | Partial | `assertIndiaResidency()`; Cloudflare R2 cannot be pinned to India (needs `DATA_RESIDENCY_R2_ACK` or an India-region bucket for personal data) |
| Significant Data Fiduciary duties (DPO in India, independent audit, DPIA, algorithmic due diligence, possible data localisation) | Act s.10, Rule 13 | Open | Not designated. Reassess at scale: the Government notifies SDFs by volume and sensitivity |
| Moderation appeal / takedown workflow | ADR-010, IT Rules | Done | `packages/compliance/src/appeals.ts`; seller `/appeals`; admin queue |
| IT Rules grievance officer: acknowledge 24 h, resolve 15 d | IT Rules 2021 r.3(2) | Done | Same grievance flow (stricter default applied) |

## Cross-cutting evidence

- Retention runs: admin Compliance > Retention.
- Residency: admin Compliance > Residency; `assertIndiaResidency()` at startup with `DATA_RESIDENCY_ENFORCE=true` in production.
- Every staff action on grievances, appeals and retention dry-runs is in `AdminAuditLog`.
