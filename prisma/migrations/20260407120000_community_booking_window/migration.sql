ALTER TABLE "communities" ADD COLUMN "booking_window_time_zone" TEXT NOT NULL DEFAULT 'Europe/Kyiv';
ALTER TABLE "communities" ADD COLUMN "booking_window_start_hour" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "communities" ADD COLUMN "booking_window_end_hour" INTEGER NOT NULL DEFAULT 24;
