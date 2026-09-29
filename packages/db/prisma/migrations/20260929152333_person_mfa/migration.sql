

-- CreateTable
CREATE TABLE "person_mfa" (
    "person_id" UUID NOT NULL,
    "totp_secret_enc" TEXT,
    "enabled_at" TIMESTAMPTZ,
    "recovery_code_hashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_used_step" BIGINT,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "person_mfa_pkey" PRIMARY KEY ("person_id")
);

