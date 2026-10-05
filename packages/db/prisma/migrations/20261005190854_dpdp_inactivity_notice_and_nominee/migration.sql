

-- AlterTable
ALTER TABLE "persons" ADD COLUMN     "last_active_at" TIMESTAMPTZ;

-- CreateTable
CREATE TABLE "inactivity_erasure_notices" (
    "id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "last_active_at" TIMESTAMPTZ NOT NULL,
    "noticed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "erase_after" TIMESTAMPTZ NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resolution" TEXT,
    "resolved_at" TIMESTAMPTZ,

    CONSTRAINT "inactivity_erasure_notices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_nominees" (
    "id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "name_enc" TEXT NOT NULL,
    "contact_enc" TEXT NOT NULL,
    "relationship_enc" TEXT NOT NULL,
    "contact_index" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ,

    CONSTRAINT "data_nominees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nominee_requests" (
    "id" UUID NOT NULL,
    "person_id" UUID,
    "requester_name_enc" TEXT NOT NULL,
    "requester_contact_enc" TEXT NOT NULL,
    "contact_index" TEXT NOT NULL,
    "ground" TEXT NOT NULL,
    "message_enc" TEXT NOT NULL,
    "nominee_matched" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "review_note" TEXT,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ,
    "action_taken" TEXT,
    "action_note" TEXT,
    "completed_at" TIMESTAMPTZ,
    "due_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nominee_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inactivity_erasure_notices_status_erase_after_idx" ON "inactivity_erasure_notices"("status", "erase_after");

-- CreateIndex
CREATE INDEX "inactivity_erasure_notices_person_id_idx" ON "inactivity_erasure_notices"("person_id");

-- CreateIndex
CREATE INDEX "data_nominees_person_id_status_idx" ON "data_nominees"("person_id", "status");

-- CreateIndex
CREATE INDEX "data_nominees_contact_index_idx" ON "data_nominees"("contact_index");

-- CreateIndex
CREATE INDEX "nominee_requests_status_due_at_idx" ON "nominee_requests"("status", "due_at");

-- CreateIndex
CREATE INDEX "nominee_requests_person_id_idx" ON "nominee_requests"("person_id");

