-- DB-level enforcement of the append-only tables (security audit M5). Until now "append-only" was only app code; anyone
-- with SQL access (or one stray updateMany) could rewrite the audit log, the credit/ad-wallet/escrow ledgers, the consent
-- ledger, the domain event log or the cookie-consent receipts.
--
-- Raw SQL that Prisma cannot model (like the pgvector HNSW indexes): `prisma migrate diff` never sees triggers, so
-- `pnpm db:new` neither drops nor needs to strip them; packages/db/scripts/raw-sql-guard.ts asserts this migration is present.
--
-- Rules
--   UPDATE   rejected on every guarded table, except
--              domain_events           -> only published_at may change (the outbox relay)
--              cookie_consent_receipts -> only person_id -> NULL (DPDP erasure)
--   DELETE   rejected unless the transaction opted in with  SELECT set_config('cnote.allow_purge', 'on', true)
--            (= SET LOCAL cnote.allow_purge = 'on'). Only the retention purge code does that (withPurge() in @cnote/db).
--   TRUNCATE rejected unless the same setting is on.
-- (Default SQLSTATE P0001 on purpose: Prisma maps restrict_violation 23001 to a misleading foreign-key error and hides the message.)
-- A least-privilege production role can be layered on top: docs/ops/db-roles.md.

CREATE OR REPLACE FUNCTION cnote_purge_allowed() RETURNS boolean LANGUAGE sql STABLE AS
$fn$ SELECT coalesce(current_setting('cnote.allow_purge', true), '') = 'on' $fn$;

-- Plain append-only tables: no UPDATE ever; DELETE/TRUNCATE only inside a retention purge.
CREATE OR REPLACE FUNCTION cnote_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'append-only table "%": UPDATE is not allowed (record a correction as a new row)', TG_TABLE_NAME;
  END IF;
  IF NOT cnote_purge_allowed() THEN
    RAISE EXCEPTION 'append-only table "%": % is not allowed outside a retention purge (SET LOCAL cnote.allow_purge = ''on'')', TG_TABLE_NAME, TG_OP;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN RETURN NULL; END IF;
  RETURN OLD;
END
$fn$;

-- domain_events: the relay may only stamp published_at.
CREATE OR REPLACE FUNCTION cnote_domain_events_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS NOT DISTINCT FROM OLD.id
       AND NEW.type IS NOT DISTINCT FROM OLD.type
       AND NEW.version IS NOT DISTINCT FROM OLD.version
       AND NEW.aggregate_type IS NOT DISTINCT FROM OLD.aggregate_type
       AND NEW.aggregate_id IS NOT DISTINCT FROM OLD.aggregate_id
       AND NEW.payload IS NOT DISTINCT FROM OLD.payload
       AND NEW.occurred_at IS NOT DISTINCT FROM OLD.occurred_at THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'append-only table "domain_events": only published_at may be updated';
  END IF;
  IF NOT cnote_purge_allowed() THEN
    RAISE EXCEPTION 'append-only table "domain_events": % is not allowed outside a retention purge (SET LOCAL cnote.allow_purge = ''on'')', TG_OP;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN RETURN NULL; END IF;
  RETURN OLD;
END
$fn$;

-- cookie_consent_receipts: DPDP erasure may only null person_id.
CREATE OR REPLACE FUNCTION cnote_cookie_receipts_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.person_id IS NULL
       AND NEW.id IS NOT DISTINCT FROM OLD.id
       AND NEW.consent_id IS NOT DISTINCT FROM OLD.consent_id
       AND NEW.app IS NOT DISTINCT FROM OLD.app
       AND NEW.policy_version IS NOT DISTINCT FROM OLD.policy_version
       AND NEW.analytics IS NOT DISTINCT FROM OLD.analytics
       AND NEW.marketing IS NOT DISTINCT FROM OLD.marketing
       AND NEW.functional IS NOT DISTINCT FROM OLD.functional
       AND NEW.gpc IS NOT DISTINCT FROM OLD.gpc
       AND NEW.action IS NOT DISTINCT FROM OLD.action
       AND NEW.locale IS NOT DISTINCT FROM OLD.locale
       AND NEW.client_at IS NOT DISTINCT FROM OLD.client_at
       AND NEW.registry_hash IS NOT DISTINCT FROM OLD.registry_hash
       AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'append-only table "cookie_consent_receipts": only person_id may be set to NULL (DPDP erasure)';
  END IF;
  IF NOT cnote_purge_allowed() THEN
    RAISE EXCEPTION 'append-only table "cookie_consent_receipts": % is not allowed outside a retention purge (SET LOCAL cnote.allow_purge = ''on'')', TG_OP;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN RETURN NULL; END IF;
  RETURN OLD;
END
$fn$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['admin_audit_log', 'credit_ledger', 'ad_wallet_ledger', 'consents', 'ledger_journals', 'ledger_lines'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS cnote_append_only ON %I', t);
    EXECUTE format('CREATE TRIGGER cnote_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION cnote_append_only_guard()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS cnote_append_only_truncate ON %I', t);
    EXECUTE format('CREATE TRIGGER cnote_append_only_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION cnote_append_only_guard()', t);
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS cnote_append_only ON domain_events;
CREATE TRIGGER cnote_append_only BEFORE UPDATE OR DELETE ON domain_events
  FOR EACH ROW EXECUTE FUNCTION cnote_domain_events_guard();
DROP TRIGGER IF EXISTS cnote_append_only_truncate ON domain_events;
CREATE TRIGGER cnote_append_only_truncate BEFORE TRUNCATE ON domain_events
  FOR EACH STATEMENT EXECUTE FUNCTION cnote_domain_events_guard();

DROP TRIGGER IF EXISTS cnote_append_only ON cookie_consent_receipts;
CREATE TRIGGER cnote_append_only BEFORE UPDATE OR DELETE ON cookie_consent_receipts
  FOR EACH ROW EXECUTE FUNCTION cnote_cookie_receipts_guard();
DROP TRIGGER IF EXISTS cnote_append_only_truncate ON cookie_consent_receipts;
CREATE TRIGGER cnote_append_only_truncate BEFORE TRUNCATE ON cookie_consent_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION cnote_cookie_receipts_guard();
