-- Data migration: populate matches.refund_reason for leads refunded before the column existed, from the
-- append-only LeadRefunded events (the previous source of truth for the fake-buyer flag count).
UPDATE "matches" m
SET "refund_reason" = e."payload"->>'reason'
FROM "domain_events" e
WHERE e."type" = 'LeadRefunded'
  AND (e."payload"->>'matchId')::uuid = m."id"
  AND m."refund_reason" IS NULL;
