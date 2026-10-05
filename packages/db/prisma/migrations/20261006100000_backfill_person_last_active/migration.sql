-- Backfill the durable last-activity marker from what we still hold (sessions are purged after 90 days; older people fall back to sign-up).
UPDATE "persons" p
SET "last_active_at" = GREATEST(p."created_at", COALESCE((SELECT MAX(s."last_used_at") FROM "auth_sessions" s WHERE s."person_id" = p."id"), p."created_at"))
WHERE p."last_active_at" IS NULL;
