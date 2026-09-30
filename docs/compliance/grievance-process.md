# Grievance redressal process

Applies to DPDP data-principal grievances and to content complaints. Code: `packages/compliance/src/grievance.ts`. Public form: `/grievance` (web). Account view: `/account/grievances`. Staff queue: admin Compliance > Grievances (needs `compliance.read`; responding needs `compliance.manage`, held by `super_admin` and `ops_moderator`).

## Legal basis

- **DPDP Act 2023 s.8(10) and s.13, DPDP Rules 2025 (notified 13 Nov 2025)**: a data fiduciary must publish grievance redressal contact details and respond within a period prescribed by the Rules (reported as not more than 90 days). A principal must exhaust this route before approaching the Data Protection Board.
- **IT (Intermediary Guidelines and Digital Media Ethics Code) Rules 2021, r.3(2)**: the Grievance Officer acknowledges a complaint within 24 hours and disposes of it within 15 days. Certain content categories have a 72-hour window under the 2022/2023 amendments; treat those as urgent.

We adopt the stricter figures as defaults: **acknowledge in 24 hours, resolve in 15 days** (`GRIEVANCE_ACK_HOURS`, `GRIEVANCE_RESOLVE_DAYS`). Verify against the gazetted texts; the sources are summarised in `dpdp-checklist.md`.

## Flow

1. **File.** Signed-in users or anonymous visitors (contact email required) submit a category (access, correction, erasure, consent, content, other), subject and details. Rate limit: 5 per raiser per hour (`GRIEVANCE_RATE_LIMIT_PER_HOUR`). A `GrievanceTicket` is created with `dueAt = now + resolve window` and `GrievanceFiled` is emitted.
2. **Acknowledge (<= 24 h).** The Grievance Officer opens the ticket and clicks *Acknowledge*: status `in_progress`. There is no separate timestamp column; a ticket still `open` after 24 hours is flagged "Acknowledgement overdue".
3. **Work.** Access/correction/erasure requests are executed with the data-principal tooling (`exportPersonalData`, `erasePerson`, consent controls) and recorded in the resolution text.
4. **Close.** *Resolve* or *Close without action* with a resolution text the person sees; `GrievanceResolved` is emitted. Every response is written to the admin audit log (`grievance.respond`).
5. **Escalation.** The person may complain to the Data Protection Board if unsatisfied. Tell them so in the resolution.

## SLA monitoring

`sweepGrievanceSla` runs hourly in the worker, counts acknowledgement and resolution breaches (and tickets due within 3 days) and logs a warning. The admin queue shows badges (Acknowledgement overdue, Resolution overdue, Due within 3 days) and a *SLA breached* filter. Configure the on-call alert on the `[compliance] grievance SLA breach` log line.

## Privacy of the queue

Contact emails are stored lower-cased but only returned masked (`a***@example.com`). Staff reply to anonymous raisers through the address held in the database by the mail tooling; there is no reveal action in the console.

## Configuration

`GRIEVANCE_OFFICER_NAME`, `GRIEVANCE_OFFICER_EMAIL` (shown on `/grievance`), `GRIEVANCE_ACK_HOURS`, `GRIEVANCE_RESOLVE_DAYS`, `GRIEVANCE_RATE_LIMIT_PER_HOUR`.

## Moderation appeals

Sellers and authors appeal a rejected listing version, image, review/comment or storefront version from the item (seller app `Appeal this decision`; list at `/appeals`). Ownership and "actually rejected" are verified through the owning modules. One appeal per decision. Upheld appeals re-approve images, reviews and comments automatically through the owning module's staff function; for listing and storefront versions the appeal is marked resolved with a follow-up note (the seller resubmits and staff fast-track), because those review functions only accept items still in review.
