

-- CreateTable
CREATE TABLE "product_questions" (
    "id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "author_person_id" UUID NOT NULL,
    "author_business_id" UUID,
    "body" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "pii_stripped" BOOLEAN NOT NULL DEFAULT false,
    "status" "ugc_status" NOT NULL DEFAULT 'pending',
    "moderation_note" TEXT,
    "ai_verdict" TEXT,
    "ai_decision_id" UUID,
    "moderated_by" UUID,
    "moderated_at" TIMESTAMPTZ,
    "report_count" INTEGER NOT NULL DEFAULT 0,
    "answered_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_answers" (
    "id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "seller_business_id" UUID NOT NULL,
    "author_person_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "pii_stripped" BOOLEAN NOT NULL DEFAULT false,
    "status" "ugc_status" NOT NULL DEFAULT 'pending',
    "moderation_note" TEXT,
    "ai_verdict" TEXT,
    "ai_decision_id" UUID,
    "moderated_by" UUID,
    "moderated_at" TIMESTAMPTZ,
    "helpful_count" INTEGER NOT NULL DEFAULT 0,
    "report_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_answers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_questions_listing_id_status_answered_at_idx" ON "product_questions"("listing_id", "status", "answered_at");

-- CreateIndex
CREATE INDEX "product_questions_seller_business_id_status_created_at_idx" ON "product_questions"("seller_business_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "product_questions_author_person_id_listing_id_idx" ON "product_questions"("author_person_id", "listing_id");

-- CreateIndex
CREATE INDEX "product_questions_status_created_at_idx" ON "product_questions"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "product_answers_question_id_key" ON "product_answers"("question_id");

-- CreateIndex
CREATE INDEX "product_answers_status_created_at_idx" ON "product_answers"("status", "created_at");

-- CreateIndex
CREATE INDEX "product_answers_listing_id_status_idx" ON "product_answers"("listing_id", "status");

-- AddForeignKey
ALTER TABLE "product_answers" ADD CONSTRAINT "product_answers_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "product_questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

