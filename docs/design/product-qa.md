# Product questions and answers

Buyers ask a product's seller a question on the product page; the seller answers from the seller portal; the Q&A is public once answered and approved. Trust levers: ADR-002 (no off-platform lead leakage), ADR-003 (moderation, trust), ADR-008 (AI behind `@cnote/ai`, human in the loop), ADR-010 (PII).

## Where it lives: `@cnote/reviews`

Extended with `ProductQuestion` and `ProductAnswer` (schema `reviews.prisma`), not a new module. Reasons:

- Reviews already owns user-generated content on a listing: the `UgcStatus` lifecycle, the AI pre-screen (`screenText`), the staff queue and `moderate()` (audited by the admin app), the `UgcReaction` helpful/report pattern with the report threshold, DPDP erasure and retention hooks, seller-side listing scoping, author-name resolution and tag-based cache invalidation. A separate module would copy all of it and add a second moderation queue.
- The dependency graph does not change: reviews already depends on `ai`, `catalogue`, `core`, `db`, `enquiry`, `identity`; notifications already depends on reviews. `check:boundaries` stays green (two new models in reviews' own schema file).
- The old `ProductComment` (generic, threaded, every item staff-held) is left in place and no longer rendered on the PDP; the new section replaces its "Questions & answers" block. Its data model could not express "private until answered", one answer per question, or the seller inbox's unanswered-first ordering.

## Lifecycle and visibility

| State | Asker | Seller (inbox) | Public / JSON-LD |
| --- | --- | --- | --- |
| question held (AI said review/block, or model down) | sees "Being checked" | no | no |
| question approved (AI allow, or staff) | sees "Waiting for the seller" | yes, needs an answer | no |
| answer held (flagged / model down) | still waiting | sees "Awaiting approval" | no |
| question and answer approved | sees the answer | yes | yes (first page in static HTML, FAQPage JSON-LD) |
| rejected / reported over threshold | sees "Not approved" (+ note) | rejected answer reopens the question | no |

`ProductQuestion.answeredAt` mirrors "question approved and answer approved", maintained in the same transaction by `syncAnswered`, so the public list is one indexed query. A clean question is auto-approved only because it is private until a moderated answer exists; answers pass the same gate. Block verdicts never auto-reject: they go to staff.

## Contact stripping (not rejection)

`stripContact` removes phone numbers, emails, Aadhaar/PAN/GSTIN, messenger links (wa.me, t.me) and long digit runs before anything is stored or sent to the model, and the asker or seller is told ("We removed contact details", plus a standing hint under the field). Text that is only contact details is refused. The category slug is passed to `ai.moderate` for the prohibited-category check (ADR-003/010).

## Phone verification

The reviews flow does not require T0 phone verification for any UGC (reviews, comments), so Q&A does not either. The controls are sign-in, per-person limits (5/hour, 15/day, 3 unanswered per product), a per-IP limit (20/hour, via `clientIp()`), duplicate detection, and AI + staff moderation. Revisit with reviews if ADR-003 later makes T0 a UGC prerequisite.

## Static PDP, cached reads

The PDP stays ISR. The first page of answered questions is a tagged read (`cachedTagged` in the module, `unstable_cache` in the web data layer), tag `qa:<listingId>` (`cacheTags.qa`, `qaAll` for erasure). `ProductQuestionAnswered` and `ProductQaModerated` purge it (cache worker, hard purge; also post-commit `invalidateTags` inside the module). Search and "show more" go through `/api/qa/<id>` (browse pages CDN-cacheable; searches uncached and rate-limited per IP). The ask form and the viewer's own questions are client islands reading `/api/me/qa/<id>` (private, no-store).

## Events (ADR-007, version 1, emitted in the state-change transaction)

- `ProductQuestionAsked`: question created (carries `status`, `aiVerdict`, `piiStripped`).
- `ProductQuestionAnswered`: answer created or edited.
- `ProductQaModerated`: staff decision on a held or reported question or answer (additional to the two requested: it drives the cache purge and the "released" notifications, and feeds the moderation metrics).

## Notifications (template keys registered via `defineTemplates`, copy editable in the admin studio)

`qa.question_asked` and `qa.question_released` (seller), `qa.answered` and `qa.answer_released` (buyer). "Asked" and "answered" fire only when the item is already approved; held items notify on staff approval (`*_released`).

## Seller app

`/questions`: unanswered first (oldest waiting first), filter "Needs an answer", answer form with the stripping hint, own answer shown with its moderation state, count badge in the sidebar nav (with a screen-reader label). 8 locales (`questions` namespace).

## Admin

Moderation page gains "Product questions" and "Product answers" tabs reusing the existing card, status filter and `DecisionForm`; decisions go through `moderateAction` -> `audited(ctx, "ugc.moderate", ...)` with before/after snapshots.

## Accessibility (buyer web, WCAG 2.2 AA)

A labelled region (`aria-labelledby`), a `role="search"` form with a visible label, a polite live region for result counts, questions as list items with screen-reader "Question"/"Answer" prefixes, `noValidate` form so server-side errors are shown in a `role="alert"` linked by `aria-describedby` with `aria-invalid`, 44px-class targets, native `<details>` for reporting. Covered by `e2e/a11y/product-qa.spec.ts` (axe in empty, error and populated states; keyboard-only ask and search).

## Design research (Mobbin)

- Product Q&A section, answers list with "Selected as best" and upvote affordances (Intercom community thread, Mobbin section `99258afb-be40-4a58-9384-14adf177a405`): adopted the question-first list with a seller-answer block and a single helpful action per answer; skipped threads/nesting (one authoritative seller answer).
- Search over answers (Intercom Q&A hub, `d931af6c-1605-47e3-a975-b56cc90e5125`): a prominent labelled search above the list.
- FAQ lists (Farm Minerals `82a675c9-a7cd-4930-9fb2-d94fcefe242f`, KÖPPEN `09028542-9505-40c7-b979-f26d42605598`): FAQ-style pairs, which also informed the FAQPage JSON-LD.
- Seller inbox (Gorgias ticket view `cb663cdc-adc7-4b38-846e-0cdeae844df6`, Plain threads "Needs first response" `db1a5cad-1e3d-428f-ab61-35ca043e0dbc`, Featurebase inbox `ef272f7e-143d-4662-a544-be9dbeb5391f`): unanswered-first ordering, a "needs a reply" filter and an unread-style count badge; the answer box sits inline on each card rather than in a split pane, matching the existing seller Reviews page.

## Not done / follow-ups

- Mobile bottom nav does not carry the Questions badge (the item lives in the sidebar like Reviews).
- Search is `ILIKE` on question/answer text (bounded, rate-limited); move to FTS/pgvector if volume warrants.
- Non-Hindi seller/web catalogues are machine-drafted and flagged for native review.
