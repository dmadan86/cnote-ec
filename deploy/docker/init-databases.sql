-- Runs once when the postgres volume is first created (docker-entrypoint-initdb.d).
-- The LIVE read database (CQRS, ADR-033) is a separate database with its own migrations (packages/live-db).
CREATE DATABASE cnote_live OWNER cnote;
