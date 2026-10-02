# Database roles: optional least privilege for production

Security audit M5 put the append-only guarantees into Postgres triggers (migration `20261003000000_append_only_triggers`, see
`docs/security/security-architecture.md` section 8). The triggers stop application bugs and ad-hoc `UPDATE`/`DELETE` statements, but
`cnote.allow_purge` is an ordinary session setting: anyone who can run arbitrary SQL **as the role that owns the tables** can set it
(or `ALTER TABLE ... DISABLE TRIGGER`). Running the apps as a role that is neither the owner nor a superuser closes that gap, and
column-level grants make the most important rows immutable even if a trigger were dropped.

This is optional hardening. The stock deployment (one role) is safe against mistakes, not against SQL injection with stacked
statements or a stolen application credential. Do it before storing real money or consent evidence.

## Roles

| Role | Used by | Can |
| --- | --- | --- |
| `cnote_owner` | `prisma migrate deploy` (the `migrate` job), DBA | owns every object; runs migrations; **never** used by an app |
| `cnote_app` | web, seller, admin, studio, api, worker (`DATABASE_URL`) | DML only, with the restrictions below |
| `cnote_readonly` (optional) | analytics / BI / the live-db projector's source reads | `SELECT` |

`LIVE_DATABASE_URL` (the CQRS read database) has no append-only tables; give the apps a normal read/write role there.

## Setup

Run once as a superuser (or the managed-database admin), per database. Adjust names and passwords (use your secret manager).

```sql
CREATE ROLE cnote_owner  LOGIN PASSWORD '...' ;
CREATE ROLE cnote_app    LOGIN PASSWORD '...' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

ALTER DATABASE cnote OWNER TO cnote_owner;
ALTER SCHEMA public OWNER TO cnote_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO cnote_app;
```

Migrations run as `cnote_owner` (`DATABASE_URL` of the migrate job). After every migration that adds tables, re-run the grants block
below (or let default privileges do it, see the end):

```sql
-- as cnote_owner
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cnote_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cnote_app;

-- Append-only tables: the app may only INSERT and SELECT ...
REVOKE UPDATE, DELETE, TRUNCATE ON
  admin_audit_log, credit_ledger, ad_wallet_ledger, consents, ledger_journals, ledger_lines,
  domain_events, cookie_consent_receipts
FROM cnote_app;

-- ... plus the three narrow exceptions the code actually needs (the triggers allow the same and nothing more):
GRANT UPDATE (published_at) ON domain_events TO cnote_app;            -- the outbox relay
GRANT UPDATE (person_id)    ON cookie_consent_receipts TO cnote_app;  -- DPDP erasure (person_id -> NULL)
GRANT DELETE                ON cookie_consent_receipts TO cnote_app;  -- retention purge (compliance.cookie_consent_receipts)
```

With these grants:

- `UPDATE credit_ledger ...`, `DELETE FROM admin_audit_log`, `TRUNCATE consents` fail with *permission denied* before the trigger runs;
  setting `cnote.allow_purge` buys nothing.
- `cnote_app` is not the owner, so it cannot `ALTER TABLE`, `DROP TRIGGER` or `DISABLE TRIGGER`.
- The cookie-receipt purge keeps working (`withPurge` sets the setting; the grant permits the `DELETE`). The triggers still reject any
  other change to those rows.
- `domain_events` has no retention purge today. If you add one, grant `DELETE` on it the same way and use `withPurge` in the purge code.

Do **not** run the dev seed reset (`pnpm db:seed` reset path) against a database prepared this way: it deletes consents and needs the owner role.

## Keeping it correct

- New append-only tables: add the table to the migration's trigger list (copy the pattern) **and** to the `REVOKE` list above. Review this
  file in the same PR.
- Make the grants part of the release: run the `GRANT`/`REVOKE` block as `cnote_owner` right after `migrate deploy` (a second step in
  the `migrate` job). Optionally also `ALTER DEFAULT PRIVILEGES FOR ROLE cnote_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cnote_app;`
  so new tables work immediately; the `REVOKE` list still has to be re-applied for new append-only tables.
- Verify after each deploy (as `cnote_app`): `UPDATE credit_ledger SET delta = delta WHERE false;` must fail with `permission denied`, and
  `SELECT has_table_privilege('cnote_app', 'admin_audit_log', 'DELETE');` must be `false`.
- Backups and restores (`docs/ops/backup-restore.md`) run as `cnote_owner`/superuser; `COPY` and `pg_restore` data loads do not fire row triggers.
- Managed Postgres: use the provider's role/grant mechanism; the SQL above is standard (RDS, Cloud SQL, Azure Database for PostgreSQL).
