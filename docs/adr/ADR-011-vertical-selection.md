# ADR-011: Phase-1 vertical selection

**Status:** Proposed — recommended, pending field validation (20+ interviews per ADR-011)

Supersedes nothing; completes the open decision in `ADR-v0.1.md` (ADR-011). Evidence and scoring: `docs/research/vertical-selection.md`.

## Context

ADR-011 requires a Phase-1 vertical chosen on: fraud/quality pain, structured specs, repeat purchase, Bengaluru-reachable seller clusters, low regulatory risk. Shortlist: (a) industrial MRO and safety, (b) packaging materials, (c) construction hardware and fasteners, (d) apparel/textile job-work.

## Recommendation

**Packaging materials, Bengaluru corridor (corrugated boxes, kraft/board, films and tapes, sacks, containers).** Weighted score 87/100 against 72 (fasteners), 69 (apparel job-work) and 68 (MRO and safety). Reasons:

1. Specs are fully structured (size, ply, GSM, burst factor, flute, print), which is what the embedding and attribute-schema design assumes. Our eval fixtures already extract ply and GSM from Hinglish text.
2. Spec shortfall (GSM/ply/burst) is a measurable quality pain, so verification and trust scoring have something concrete to score.
3. Consumable, monthly repeat purchase.
4. Dense reachable clusters: Peenya, Jigani, Bommasandra, Nelamangala-Dabaspete, Doddaballapura, with Hosur and Tumakuru as the outer ring.
5. Lowest regulatory exposure of the four. No BIS QCO identified on corrugated boxes; polymer QCOs were rescinded in November 2025. Exposure is limited to food-contact packaging (FSSAI), plastic-waste rules and thin-bag bans, handled as certificate-gated or prohibited subcategories.

Second vertical (ADR-016): industrial MRO and safety, once a certificate-gated listing flow exists and the first vertical meets its gates. Avoid fasteners until the steel-fastener QCO settles, and defer apparel job-work until escrow (ADR-012) can address its payment pain.

## Language ordering

For the packaging playbook (first = primary for seller onboarding copy, WhatsApp prompts and category labels):

`hi` (Hinglish-first), `en`, `kn`, `ta`, `te`

Rationale: trader/owner communication in packaging is mixed Hindi/English/Hinglish **[hypothesis]**, the workforce and local suppliers around Peenya and Jigani are Kannada-speaking, and Hosur/Doddaballapur add Tamil and Telugu. ADR-004 still limits buyer web to `en` and `hi`; the other three affect seller app and WhatsApp copy only. Interviews must confirm or reorder this (see validation checklist).

## Decision mechanics

- The playbook is data in `@cnote/verticals` (`PLAYBOOKS["packaging-bengaluru"]`), validated by tests, and **not loaded by default**. Staff load it with `pnpm db:seed -- --vertical=packaging-bengaluru --only` (creates categories plus a `candidate` vertical with the ADR-016 checklist). No code path names the vertical.
- Loading does not open the vertical. Stage changes remain governed by ADR-016 gates.
- If interviews flip the decision, add another playbook file and load that instead; nothing else changes.

## Field validation plan (ADR-011: 20+ interviews)

Target 24 interviews minimum: 14 sellers, 10 buyers, in four weeks, in the languages above, preferably in person at the cluster and over WhatsApp voice.

### Who to interview

Sellers (14):
- 5 corrugated box makers (2 in Peenya, 1 Jigani, 1 Nelamangala/Dabaspete, 1 Bommasandra), mix of 3-ply and 5/7-ply specialists.
- 3 kraft paper / board traders.
- 3 plastic film, tape and sack converters/traders.
- 2 packaging distributors who resell and quote from several makers.
- 1 association contact (Peenya Industries Association or a box-manufacturers body) as cluster partner.

Buyers (10):
- 4 factory purchase managers in the same areas (auto ancillary, electronics, engineering).
- 3 D2C/e-commerce shippers.
- 2 food or FMCG small producers (tests the FSSAI exposure).
- 1 procurement person at a mid-sized exporter.

Mix by language: at least 5 sellers who primarily operate in Kannada, 5 in Hindi/Hinglish, 2 in Tamil or Telugu.

### Interview script (seller, 30 min, voice-note friendly)

1. Warm-up: what do you make or sell, since when, how many people, how many orders a month, typical order size in rupees.
2. How do new customers reach you today (IndiaMART, Justdial, WhatsApp, walk-in, agents)? Which is best and what does it cost per month?
3. Last three enquiries you received from IndiaMART or similar: were they real, were they shared with others, how many closed?
4. Last time a customer disputed quality or paid late: what was the issue (GSM, ply, size, burst, print, delivery), what happened, what did it cost?
5. How do you describe a product to a buyer? Show me a recent WhatsApp quote. Which attributes do you always state? Which do buyers ask for?
6. Which units and terms do you quote in (per piece, per kg, per sheet; MOQ; advance)? Do you quote different prices at different quantities?
7. Would you accept: at most 3 sellers per lead, you see your rank and intent score, pay only on accept, auto-refund within 72h if the buyer is fake? What price per lead feels fair? What would make you not trust it?
8. Would you upload a test report or GST certificate to get a verified badge? What would stop you?
9. Which language do you want the app and WhatsApp in? Can you type a listing, or must it be voice?
10. Do you sell outside Bengaluru? How far will you deliver economically?
11. What is the one thing a platform would have to do for you to move your top 10 customers onto it?

### Interview script (buyer, 25 min)

1. What do you buy (boxes, tape, film, sacks), how often, in what quantity, typical spend per month?
2. How do you find and choose a supplier today? How many do you ask for quotes?
3. Worst packaging purchase in the last year: what went wrong, what did it cost, what did you do?
4. How do you check spec on delivery (GSM, ply, burst, size)? Do you test?
5. Do you trust IndiaMART or Moglix listings? Why or why not?
6. Would a verified-spec badge change whom you choose? Would you pay a premium or a fee for verified suppliers?
7. How do you want to send a requirement (type, photo, voice, Hinglish)? Show me your last RFQ.
8. What languages do you and your suppliers use?
9. Do you need GST invoices, credit terms, delivery to site? What lead time is acceptable?
10. For food/FMCG buyers: which food-contact documents do you demand from a supplier?

### Validation checklist (all must be recorded in `docs/research/vertical-validation-log.md`, created when interviews start)

- [ ] 20+ interviews done (14+ sellers, 10+ buyers) with notes and language of the interview.
- [ ] At least 12 of 14 sellers say they would trial a capped-lead model for one month.
- [ ] At least 7 of 10 buyers can name a quality or spec incident in the last 12 months with a rupee cost.
- [ ] At least 8 of 14 sellers state ply/GSM/size as the attributes buyers ask about (confirms the schema); schema gaps logged.
- [ ] Median order value verified; at least 60% of orders between Rs 10,000 and Rs 3 lakh.
- [ ] Cluster census: at least 150 reachable seller businesses identified across Peenya, Jigani, Bommasandra, Nelamangala and Doddaballapura (the 200-verified-seller gate in ADR-016 needs that funnel).
- [ ] Language ordering confirmed: the language in which the majority of sellers prefer onboarding is recorded; reorder the playbook if it differs from `hi, en, kn, ta, te`.
- [ ] Regulatory check with a BIS-empanelled consultant or counsel: confirm no QCO currently applies to corrugated boxes, kraft paper, and the plastic items in the playbook; confirm PWM/EPR obligations and jute reservation norms for the listed subcategories.
- [ ] Competitor spot check: the same 10 searches on IndiaMART and Moglix, noting fake or unreachable sellers.

### What would flip the decision

Switch to another shortlisted vertical (or hold and extend validation) if any of these holds:

1. **Pain is weak:** fewer than 5 of 10 buyers can describe a costly quality incident, or sellers say price-only comparison is what buyers want and verification has no willingness to pay.
2. **Liquidity is thin:** the census finds under 100 reachable sellers, or more than half sell only to known local accounts and will not take unknown buyers.
3. **Unit economics:** median order under Rs 5,000 so a lead credit cannot be priced against margin, or buyers insist on unit price per kg in a way that makes ranking commodity-only.
4. **Regulation:** counsel finds a BIS QCO or EPR/FSSAI obligation that the platform must police for mainstream corrugated and board listings.
5. **Language:** over 60% of sellers need Kannada or Tamil voice-first and our WhatsApp onboarding cannot support that at launch (the playbook is language-agnostic, but the go-to-market cost changes).
6. **Competitor signal:** a packaging-specialist B2B marketplace with credible Bengaluru supply is found.
7. **Counter-evidence for another vertical:** if 5 or more of the 10 buyers say their top unmet need is safety/MRO verification (counterfeit PPE) or fasteners grade fraud rather than packaging, re-score (a) or (c) with first-party evidence.

If flipped, the cheapest path is (a) MRO and safety, whose QCO-flagged subcategories and certificate-gating mechanism already exist in the playbook schema.

## Consequences

- Positive: Phase 1 can start seller acquisition on a concrete cluster list and schema while interviews run; nothing is hard-wired.
- Negative: desk research only; packaging may be price-led and shipping-bound. Mitigation is the flip conditions above.
- Follow-ups: wire `regulated` playbook subcategories into moderation (certificate required before auto-approval); translate category labels into `hi`/`kn`; the playbook's golden-set examples sit under `packages/ai/evals/proposed/` until the baselines are refreshed (see `docs/design/vertical-playbooks.md`).
