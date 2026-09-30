# Vertical playbook template (ADR-016)

The Phase-1 vertical is codified here so every later vertical repeats it. ADR-011 (which vertical goes first) is still open, so this template names no vertical. `createVerticalFromTemplate` in `@cnote/verticals` seeds these items as the vertical's checklist; the admin console tracks them under Verticals.

Expansion rule: a vertical moves `candidate -> pilot -> open` only while every currently open vertical has at least 200 verified sellers (tier 1 or higher, with a live listing in the vertical's categories) and positive net seller adds over the trailing 30 and 90 days. Staff can override with a written reason; the override is audited and stored on the stage-change history.

## 1. Schema
- Define the category attribute schema (fields, units, select options) in the catalogue.
- Map HSN codes and price units.
- Set the per-category lead cap (default 3).
- Review the schema with 5 real sellers.

## 2. Classifiers
- Assemble a golden set for the prohibited-category classifier (ADR-003, ADR-008).
- Fine-tune or configure the prohibited-category classifier version for the vertical.
- Fine-tune or configure the intent-scoring model version.
- Pass golden-set evals before pointing the vertical's config (`classifierConfig`) at the new versions. This package stores version pointers only.

## 3. Seller-cluster acquisition
- Name target clusters (city or district plus industry, for example "Tiruppur knitwear" as a shape, not a decision).
- Recruit an on-ground cluster partner or association.
- WhatsApp-first onboarding for the first 25 sellers (ADR-004).
- Reach 200 verified sellers; confirm positive net adds at 30 and 90 days.

## 4. Language ordering
- Set the ordered language list (subset of en, hi, kn, ta, te, mr, gu, bn); the first is primary.
- Translate onboarding prompts, category names and attribute labels.
- Test transliterated and Hinglish search queries.

## 5. Ops
- Staff the human review queue for low-confidence moderation (ADR-008).
- Lead refund handling for unreachable buyers (72h).
- Seller support scripts in the primary languages.

## 6. Compliance
- Confirm the prohibited-category list with legal (ADR-010).
- Check PII redaction on the vertical's prompts.
- Confirm data residency for vertical-specific vendors.
