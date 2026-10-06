

-- CreateTable
CREATE TABLE "person_passkeys" (
    "id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "realm" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL,
    "public_key" BYTEA NOT NULL,
    "sign_count" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "aaguid" TEXT NOT NULL,
    "device_type" TEXT NOT NULL,
    "backed_up" BOOLEAN NOT NULL DEFAULT false,
    "nickname" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "revoked_reason" TEXT,

    CONSTRAINT "person_passkeys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "person_passkeys_credential_id_key" ON "person_passkeys"("credential_id");

-- CreateIndex
CREATE INDEX "person_passkeys_person_id_realm_idx" ON "person_passkeys"("person_id", "realm");

