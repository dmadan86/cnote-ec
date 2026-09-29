# ADR-033: UGC, image and listing moderation; listing versioning with a separate LIVE read database (CQRS)

**Status:** Accepted
**Note:** Designed with parallel work; details reconcile with `packages/live-db` and `catalogue/versions.ts`.

**Context.** ADR-003 requires proactive moderation, and seller-edited listings, images, reviews and comments are the largest abuse and liability surface. Buyers must never see unapproved content, yet sellers need to edit without taking a live listing offline.

**Options.**
1. Publish first, moderate after. Fast; exposes buyers and the platform to harm.
2. Moderate before public, single mutable row. Edits either block the live listing or leak.
3. Nothing public before approval; edits create versions; approved versions project into a separate LIVE database that all buyer reads use (CQRS).

**Decision.** Option 3. Everything user-generated (listing text, images, versions, reviews, comments, storefront pages) starts `pending`, is classified by `ai.moderate` (prohibited categories; a `review` verdict always goes to a human) and reviewed in the admin moderation queue with reasons, appeal and audit. Images: originals in a private bucket, only approved derivatives are copied to the public bucket (ADR-036). Listings: sellers edit a `ListingVersion` (draft, submitted, reviewed, published); publish emits `ListingVersionPublished` and a projector writes a denormalised read model into the LIVE database (`LIVE_DATABASE_URL`, `packages/live-db`, own migrations, possibly another cluster). Buyer web and API read only LIVE; authoring writes never touch it directly. Unpublish and takedown propagate by event with a cache purge (ADR-038).

**Rationale.**
- No unapproved content is ever publicly reachable, by construction.
- Buyer read path is isolated, fast and independently scalable; authoring outages do not affect browsing.
- Version history gives audit and rollback.

**Consequences.**
- Eventual consistency between authoring and LIVE (seconds); admin UI must show 'published, propagating'.
- Two databases to migrate, back up and monitor.
- Moderation staffing and SLA become an operational load.

**Review.** Review moderation queue age and approval turnaround at 4 weeks; revisit LIVE as a separate cluster only when read load justifies it.
