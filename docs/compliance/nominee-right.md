# Right to nominate (DPDP Act s.14, Rules r.14)

A data principal can nominate another individual who may exercise the principal's rights (access, correction, erasure, grievance) if the principal dies or becomes incapable. Code: `packages/compliance/src/nominee.ts`.

## Principal: add, change, remove

- Buyer web `/account/nominee` (linked from the account page). Up to 2 active nominees. A nominee cannot be the principal's own e-mail or phone, and the same contact cannot be added twice.
- **Step-up on every change** (password, authenticator/recovery code if MFA is on, or a phone OTP verified in the last 5 minutes): identity's `verifyErasureStepUp`, rate-limited. A hijacked session cannot nominate someone.
- Name, contact and relationship are **encrypted at rest** (`@cnote/security` field encryption, context bound to the row id). `contact_index` is a keyed blind index (HMAC of the normalised contact) used only to match a request to a nomination. Revoking overwrites the ciphertexts and blanks the index immediately; the tombstone row is removed by retention.
- Each change emits `DataNomineeChanged` (no nominee details in the event) and the principal gets a security e-mail (`account.nominee_changed`, en + hi).
- The nominations are part of the principal's data export (decrypted for them). Erasing the principal deletes their nominations (`DataErasureRequested` handler).

## Nominee: request

- Public form `/grievance/nominee` (no account). Rate-limited per IP (5/hour). The confirmation is identical whether or not the account exists or the requester is a nominee. Requester name, contact and message are encrypted. The 90-day rights-request clock (`GRIEVANCE_RIGHTS_REQUEST_DAYS`) starts at filing.

## Ops: verify and act (admin, privilege `compliance.manage`)

1. `/compliance/nominees` lists requests (no personal details in the list). Opening a request decrypts the requester's details and the principal's registered nominees; **that read is audited** (`nominee_request.view`).
2. **Verify** is possible only if the requester matches an **active nomination** (re-checked at that moment) and the staff note records which documents were checked offline (death certificate or guardianship order). Otherwise the only option is **reject** (note required).
3. **Complete** a verified request with one of: release a copy of the data to the nominee, correct data, **erase the account** (`erasePerson`), other. Every decision and completion is wrapped in `audited()` and stores the staff id and note.
4. Decided requests and revoked nominations are purged after 3 years (`compliance.nominee_requests_decided`, `RETENTION_NOMINEE_REQUESTS_DAYS`).

## Decisions

- A nominee request never bypasses the principal's choice: an unregistered relative (even a legal heir) is rejected here and pointed to the court-order route; counsel decides if that should be widened.
- No self-service data release to the nominee: a person always looks at the documents first.
