-- CreateEnum
CREATE TYPE "fulfilment_stage" AS ENUM ('packed', 'in_transit', 'out_for_delivery', 'delivery_attempted');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "fulfilment_stage" "fulfilment_stage",
ADD COLUMN     "fulfilment_updated_at" TIMESTAMPTZ,
ADD COLUMN     "tracking_courier" TEXT,
ADD COLUMN     "tracking_ref" TEXT;

-- CreateTable
CREATE TABLE "order_fulfilment_events" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "stage" "fulfilment_stage" NOT NULL,
    "note" TEXT,
    "courier" TEXT,
    "tracking_ref" TEXT,
    "actor_business_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_fulfilment_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_fulfilment_events_order_id_created_at_idx" ON "order_fulfilment_events"("order_id", "created_at");

-- AddForeignKey
ALTER TABLE "order_fulfilment_events" ADD CONSTRAINT "order_fulfilment_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

