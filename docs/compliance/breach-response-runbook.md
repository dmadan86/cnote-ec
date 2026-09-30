# Personal data breach response runbook

ADR-010 requires a 72-hour breach-notification runbook. Read together with `docs/security/security-architecture.md`.

## Legal duties (verify against the gazetted text with counsel)

- **DPDP Act 2023 s.8(6)**: on a personal data breach the data fiduciary must intimate the Data Protection Board of India and each affected data principal, in the form and manner prescribed.
- **DPDP Rules 2025 (notified 13 Nov 2025, G.S.R. 846(E)), Rule 7**: (a) intimate affected data principals without delay, in plain language: what happened, when, what data, likely consequences, mitigation taken, safety steps they can take, and a contact person; (b) intimate the Board without delay with the nature, extent, timing and likely impact; (c) within **72 hours** (or a longer period the Board allows) give the Board the detailed report: updated description, cause, mitigation, findings on who caused it, remedial steps, and a summary of principal notifications.
- Any breach counts, regardless of harm likelihood. Fines for failing to take reasonable security safeguards or to notify can reach INR 250 crore and INR 200 crore respectively under the Schedule to the Act.
- **CERT-In Directions (28 Apr 2022)**: report specified cyber incidents to CERT-In within **6 hours** of noticing them. Independent of the DPDP clock.

## Clock

T0 = the moment we become aware (not the moment of the breach). Record it. T0 + 6 h: CERT-In (if in scope). T0 + as soon as practicable: principals and Board intimation. T0 + 72 h: detailed report to the Board.

## Roles

| Role | Holder | Duty |
|---|---|---|
| Incident commander | Engineering lead on call | Contain, coordinate, keep the timeline |
| Data Protection / Grievance Officer | named in `GRIEVANCE_OFFICER_*` | Legal assessment, Board and CERT-In filings, principal notices |
| Comms lead | Support lead | Principal notice, support macros, status page |
| Scribe | Anyone not fixing | Timeline, evidence log |
| Executive | Founder/CEO | Approvals, regulators, press |

## Steps

1. **Detect and declare (0-1 h).** Anyone can declare. Page the incident commander. Open the incident doc; note T0.
2. **Contain (1-4 h).** Revoke sessions (`signOutAllSessions`, Redis revocation), rotate secrets (`docs/security`), disable affected API keys (admin: API keys > revoke), pause affected workers/queues, block the vector. Do not delete evidence.
3. **Assess (2-24 h).** What data (identity, contact, GSTIN/PAN, business docs, voice notes, messages), whose, how many, which purposes, encrypted or not, cross-border exposure. Use `AdminAuditLog`, the domain event log, database and media access logs, Sentry.
4. **Notify (as soon as practicable).** Send the Board intimation (template A) and affected principals (template B) via the email service with a published DB template; for principals without email use in-app notice and WhatsApp where consented.
5. **Report (<= T0+72 h).** File the detailed report (template C). If facts are incomplete, file what is known and ask the Board for an extension.
6. **Recover and review (within 14 days).** Post-incident review, preventive actions, update risk register, retention and access reviews. Keep the file for at least one year.

## Evidence checklist

- Incident timeline with UTC timestamps and T0
- Access logs (database, object storage, API, admin audit) exported and hashed
- Scope analysis: data categories, counts, affected principals (list held separately, access controlled)
- Containment actions with who/when (audit log references)
- Copies of every notification and filing, with delivery proof
- Decision log (why notified or not, why extension)
- Root-cause analysis and remediation tickets

## Templates

**A. Board intimation (initial).** Reference; date/time of discovery (T0); nature of the breach (confidentiality/integrity/availability); data categories and approximate number of principals; when it occurred and how discovered; likely impact; containment so far; contact (Data Protection Officer name, email, phone).

**B. Notice to data principals.** Plain language, no jargon. "We found that on <date> someone gained access to <data>. This may lead to <consequence>. We have <actions>. You can <safety steps: change password, watch for phishing, do not share OTP>. Questions: <officer contact>. You may also raise a grievance at /grievance."

**C. Detailed report (72 h).** Updated description; cause and how it happened; who or what caused it (findings); mitigation and remedial measures; measures to prevent recurrence; summary of principal notifications (count, channels, dates); any CERT-In reference.

## Drill

Run a tabletop drill twice a year against a realistic scenario (leaked database snapshot, compromised admin session). Record time to declare, contain and file.
