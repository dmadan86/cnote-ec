-- CreateEnum
CREATE TYPE "ugc_status" AS ENUM ('pending', 'flagged', 'approved', 'rejected');

-- CreateTable
CREATE TABLE "product_reviews" (
    "id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "author_person_id" UUID NOT NULL,
    "author_business_id" UUID,
    "rating" SMALLINT NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "verified_enquiry" BOOLEAN NOT NULL DEFAULT false,
    "status" "ugc_status" NOT NULL DEFAULT 'pending',
    "moderation_note" TEXT,
    "ai_verdict" TEXT,
    "ai_decision_id" UUID,
    "moderated_by" UUID,
    "moderated_at" TIMESTAMPTZ,
    "seller_reply" TEXT,
    "seller_reply_status" "ugc_status",
    "seller_replied_at" TIMESTAMPTZ,
    "helpful_count" INTEGER NOT NULL DEFAULT 0,
    "report_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_comments" (
    "id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "parent_id" UUID,
    "author_person_id" UUID NOT NULL,
    "author_business_id" UUID,
    "is_seller" BOOLEAN NOT NULL DEFAULT false,
    "body" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "status" "ugc_status" NOT NULL DEFAULT 'pending',
    "moderation_note" TEXT,
    "ai_verdict" TEXT,
    "ai_decision_id" UUID,
    "moderated_by" UUID,
    "moderated_at" TIMESTAMPTZ,
    "report_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ugc_reactions" (
    "id" UUID NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ugc_reactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listing_rating_summaries" (
    "listing_id" UUID NOT NULL,
    "rating_count" INTEGER NOT NULL DEFAULT 0,
    "rating_sum" INTEGER NOT NULL DEFAULT 0,
    "histogram" INTEGER[] DEFAULT ARRAY[0, 0, 0, 0, 0]::INTEGER[],
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listing_rating_summaries_pkey" PRIMARY KEY ("listing_id")
);

-- CreateIndex
CREATE INDEX "product_reviews_listing_id_status_created_at_idx" ON "product_reviews"("listing_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "product_reviews_seller_business_id_status_idx" ON "product_reviews"("seller_business_id", "status");

-- CreateIndex
CREATE INDEX "product_reviews_status_created_at_idx" ON "product_reviews"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "product_reviews_listing_id_author_person_id_key" ON "product_reviews"("listing_id", "author_person_id");

-- CreateIndex
CREATE INDEX "product_comments_listing_id_status_created_at_idx" ON "product_comments"("listing_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "product_comments_status_created_at_idx" ON "product_comments"("status", "created_at");

-- CreateIndex
CREATE INDEX "ugc_reactions_subject_type_subject_id_idx" ON "ugc_reactions"("subject_type", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "ugc_reactions_subject_type_subject_id_person_id_kind_key" ON "ugc_reactions"("subject_type", "subject_id", "person_id", "kind");

-- AddForeignKey
ALTER TABLE "product_comments" ADD CONSTRAINT "product_comments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "product_comments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

