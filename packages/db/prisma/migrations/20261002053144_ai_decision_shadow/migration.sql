

-- AlterTable
ALTER TABLE "ai_decisions" ADD COLUMN     "shadow" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "shadow_of_id" UUID;

-- CreateIndex
CREATE INDEX "ai_decisions_shadow_capability_created_at_idx" ON "ai_decisions"("shadow", "capability", "created_at");

-- CreateIndex
CREATE INDEX "ai_decisions_shadow_of_id_idx" ON "ai_decisions"("shadow_of_id");

