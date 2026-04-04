-- CreateTable
CREATE TABLE "booking_looking_participants" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "telegram_user_id" BIGINT NOT NULL,
    "people_count" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "booking_looking_participants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "booking_looking_participants_booking_id_telegram_user_id_key" ON "booking_looking_participants"("booking_id", "telegram_user_id");

-- CreateIndex
CREATE INDEX "booking_looking_participants_booking_id_idx" ON "booking_looking_participants"("booking_id");

-- CreateIndex
CREATE INDEX "booking_looking_participants_telegram_user_id_idx" ON "booking_looking_participants"("telegram_user_id");

-- AddForeignKey
ALTER TABLE "booking_looking_participants" ADD CONSTRAINT "booking_looking_participants_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
