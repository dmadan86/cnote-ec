# Listing versioning and the LIVE read database

Status: implemented. Related: ADR-003 (moderation), ADR-007 (event log), ADR-008 (HITL), ADR-018/023 (CQRS, read models).

## Why

Sellers need history, a preview, an approval step, and "go live" must never be immediate. Buyers (web, search, public API, lead matching) must only ever be able to read published content, by construction rather than by remembering a `WHERE status = 'published'`.

So there are two databases:

| | Authoring DB (`DATABASE_URL`, `cnote`) | LIVE DB (`LIVE_DATABASE_URL`, `cnote_live`) |
|---|---|---|
| Package | `@cnote/db` | `@cnote/live-db` (own Prisma schema, own migrations, own generated client) |
| Holds | working copies (`Listing`), immutable `ListingVersion` snapshots, images, everything else | `live_listings` (published projection + embedding + tsvector), `live_categories`, `projection_checkpoints` |
| Written by | seller/staff flows | only the publisher (catalogue worker) |
| Read by | seller portal, admin, workflows | web, search, API, matching (through `@cnote/catalogue` public reads) |

There are no cross-database foreign keys or joins: ids are copied, the LIVE DB can be rebuilt from authoring at any time.

## Lifecycle

```
 seller edits working copy (Listing, status draft/published)          -- never visible to buyers
        |
        |  submitListingVersion(changeNote, publishAt?)
        v
 ListingVersion vN  (immutable snapshot + field diff vs live version)
        |  validate schema -> ai.moderate
        |
        +-- block / prohibited category ----------------> rejected      (ListingVersionReviewed rejected)
        +-- tier >= 1 && trust >= 60 && verdict allow --> approved      (auto, reviewedBy = null)
        +-- everything else ----------------------------> in_review     (staff queue: /listings in admin)
                                                              |
                                        reviewListingVersion(approve|reject + note)   -- audited "listings.moderate"
                                                              v
                                    approved  --emit-->  ListingVersionReviewed(approved)
                                                              |
                     +----------------------------------------+---------------------------+
                     | subscriber (catalogue worker handler)                              | sweep job, every 30 s
                     | publishVersion(versionId) if due                                   | approved AND publishAt <= now
                     +----------------------------------------+---------------------------+
                                                              v
                                                       PUBLISHER (publishVersion)
                     1. build projection: snapshot + category + seller trust snapshot + public image variants + embedding (ai.embed)
                     2. LIVE upsert (monotonic in version) + projection checkpoint     -- LIVE tx
                     3. authoring tx: version -> published, previous live -> superseded,
                        Listing.liveVersionId, Listing.status = published,
                        emit ListingVersionPublished (+ ListingPublished on first go-live)
                     4. purge Redis caches (listing:<id>, seller-listings, sitemap; soft: featured, search)
                                                              v
                                              buyers read LIVE (cached reads)

 unpublish / archive:  delete from LIVE first, then authoring tx (status, liveVersionId=null, open versions withdrawn,
                       emit ListingUnpublished [+ ListingArchived]), purge caches.
 withdraw:             open version -> withdrawn (live version untouched).
 new submission:       any older open (submitted / in_review / approved-not-live) version -> withdrawn: only the latest snapshot can publish.
```

Version statuses: `submitted`, `in_review`, `approved`, `published` (currently live), `superseded`, `rejected`, `withdrawn`.

Seller-visible messaging: "Live: v3 · Pending: v4 in review". A listing that has never been live shows "Not live yet · v1 in review".

## Preview

`getVersionPreview(sellerBusinessId, versionId)` (owner) and `createPreviewToken(versionId)` / `verifyPreviewToken` / `getPreviewByToken` (HMAC-SHA256 over `versionId.exp`, 1 hour, secret `PREVIEW_TOKEN_SECRET` falling back to `JWT_SECRET`). The buyer web renders `/preview/listing/<versionId>?token=…` with a "Preview, not live" banner, `noindex`, `force-dynamic` (no caching). Images come through `/preview/listing/<versionId>/media/<imageId>?token=…`, which only serves images frozen in that version's snapshot, because the public media route refuses images of unpublished listings.

## Consistency model

Eventual. Approval commits in the authoring DB and emits `ListingVersionReviewed` through the transactional outbox; the relay (~250 ms) delivers it to the catalogue consumer group, which publishes. Typical approval-to-live lag is a couple of seconds, bounded by the 30 s sweep if an event is missed; scheduled versions go live within 30 s of `publishAt`. Then Redis tags are purged, so pages (ISR + tagged cache) refresh at once or stale-while-revalidate (web `revalidate` 300 s).

Guarantees:
- A buyer never sees anything that has not been approved: LIVE only receives approved snapshots.
- LIVE never goes backwards: the upsert only applies when `live.version <= incoming.version`.
- Unpublish/archive removes from LIVE before authoring is updated, so a failure can only leave a listing hidden, never wrongly visible.
- Seller trust, badge and image data on live rows are refreshed on `TrustScoreChanged`, `BusinessVerified`, `ListingImageProcessed`, `ListingImageModerated`, and hourly by the reconciler.

## Failure and retry

- Handlers are idempotent (at-least-once delivery). `publishVersion` is a no-op unless the version is `approved`; it locks the version row (`FOR UPDATE SKIP LOCKED`) so parallel workers cannot double-publish or double-emit.
- LIVE is written before the authoring commit. If the authoring commit fails, the version is still `approved`, so the next event redelivery or the 30 s sweep repeats the (idempotent) LIVE upsert and completes the authoring side.
- If LIVE is unavailable, `publishVersion` throws: the event is retried by the consumer and the sweep logs and retries every 30 s. Approved versions simply wait; nothing is lost and buyers keep seeing the previous live version.
- `reconcileLive()` (hourly): removes LIVE rows whose listing is no longer published, restores listings that claim a live version but have no LIVE row, and refreshes seller/image snapshots.
- Rebuild from scratch: truncate `live_listings`, then `pnpm --filter @cnote/catalogue live:backfill` for listings without a live version, or clear `Listing.liveVersionId` and let `reconcileLive` re-project. `reindexEmbeddings` re-embeds LIVE rows in place after a model change.

## Operating it

1. `pnpm install` (links `@cnote/live-db`, runs its `prisma generate`).
2. Create the LIVE database with pgvector: `createdb cnote_live && psql cnote_live -c 'CREATE EXTENSION vector'`.
3. `pnpm --filter @cnote/live-db migrate:deploy` (uses `LIVE_DATABASE_URL`). New migrations: `pnpm --filter @cnote/live-db migrate:new <name>`; `migrate:check` is the CI guard for the HNSW index and the generated `search_tsv` column, same idea as `db:check`.
4. Run the worker (`pnpm worker`): it now also publishes.
5. Existing data: `pnpm --filter @cnote/catalogue live:backfill` (each published+approved listing becomes version 1 and is projected; idempotent). Run it after `pnpm db:seed`.

## Splitting LIVE onto another cluster or cloud

LIVE is just another Postgres 17 with pgvector. To move it:

1. Provision the instance (managed Postgres with pgvector: RDS, Cloud SQL, Neon, Supabase, ...).
2. Point `LIVE_DATABASE_URL` at it for the worker (the only writer) and for every reader (web, seller, admin, api, search).
3. `migrate:deploy` against it, then `live:backfill` or `reconcileLive` to fill it. Nothing else changes: there is no dependency between the two databases beyond ids.
4. Readers can use a read replica or a different region; the worker needs write access. Grant readers `SELECT` only on `live_*`; grant the worker full access.
5. Cutover is safe without downtime: fill the new LIVE, switch readers, then switch the worker.

## Known gaps

- Only one open version per listing (a newer submission withdraws the older one).
- Image deletions/rejections after go-live reach LIVE via events or the hourly reconciler (images.ts does not emit an event on soft delete).
- The web `/api/revalidate` webhook and `robots.ts` should list `ListingVersionPublished`/`ListingUnpublished` and `/preview` respectively.
- Staff takedown of a live listing (without seller action) is not built; use `unpublishFromLive` from an admin action when needed.
