-- DropIndex
DROP INDEX "auth_sessions_person_id_revoked_at_idx";

-- AlterTable
ALTER TABLE "auth_sessions" ADD COLUMN     "realm" TEXT NOT NULL DEFAULT 'web';

-- CreateIndex
CREATE INDEX "auth_sessions_person_id_realm_revoked_at_idx" ON "auth_sessions"("person_id", "realm", "revoked_at");

