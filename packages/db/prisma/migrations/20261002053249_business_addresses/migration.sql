

-- CreateTable
CREATE TABLE "business_addresses" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "contact_name" TEXT,
    "phone" TEXT,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "state_code" TEXT NOT NULL,
    "pincode" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "business_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "business_addresses_business_id_is_default_idx" ON "business_addresses"("business_id", "is_default");

-- AddForeignKey
ALTER TABLE "business_addresses" ADD CONSTRAINT "business_addresses_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

