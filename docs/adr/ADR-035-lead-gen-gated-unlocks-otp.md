# ADR-035: Lead generation via gated unlocks with OTP

**Status:** Accepted
**Note:** Detail: `docs/design/lead-generation.md`. Refines ADR-002 and ADR-003.

**Context.** Anonymous buyers should browse freely (SEO, a11y, Baymard evidence on forced accounts), but leads must be verified to protect sellers from fake enquiries. IndiaMART's aggressive gating is a documented complaint.

**Options.**
1. Force sign-in to browse.
2. Ask for a phone number on load or via intrusive modals (Google penalty risk, poor trust).
3. Guest-first; ask only at an explicit high-intent action, verify by OTP, then unlock.

**Decision.** Option 3. `@cnote/leadgen` tracks a `LeadCapture` per gated action (`started`, `otp_sent`, `verified`, `converted`, `abandoned`); only sha256(phone) is stored there. Triggers: best price, contact seller, request quote, catalogue download, compare/save beyond a limit; soft nudges are inline banners with caps (max 1 a day, 3 a week, cool-downs after dismissal), never modals on load. OTP goes by SMS or WhatsApp (DLT/authentication-template compliant), verified in `@cnote/identity` phone-login, with limits per phone, IP and visitor and Turnstile (ADR-037). Verified phone equals T0 buyer; the enquiry is matched to at most 3 sellers (ADR-002); a seller's phone is never revealed by an unlock. `funnelByTriggerDay` supplies conversion metrics; `sweepAbandoned` closes stale captures.

**Rationale.**
- Verified leads without SEO or accessibility damage.
- Honest copy: what we share, with how many suppliers, no urgency tricks; DPDP consent captured at the moment of use.
- Funnel measurable per trigger.

**Consequences.**
- Depends on real OTP providers (not yet integrated) and DLT registration lead time.
- Phone-login lifts account takeover risk (SIM swap): step-up for sensitive actions is a follow-up.
- Abuse of OTP endpoints requires ongoing rate-limit tuning.

**Review.** Review the funnel per trigger after 4 weeks; drop any trigger whose verify rate is under a set floor.
