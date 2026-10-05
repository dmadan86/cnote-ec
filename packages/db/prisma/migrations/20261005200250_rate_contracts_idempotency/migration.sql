

-- AlterTable
ALTER TABLE "rate_contract_call_offs" ADD COLUMN     "idempotency_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "rate_contract_call_offs_contract_id_idempotency_key_key" ON "rate_contract_call_offs"("contract_id", "idempotency_key");

