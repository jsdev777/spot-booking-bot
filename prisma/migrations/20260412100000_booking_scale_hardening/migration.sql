-- Indexes for hot booking/reminder paths.
CREATE INDEX "bookings_status_start_time_idx"
  ON "bookings" ("status", "start_time");

CREATE INDEX "bookings_status_end_time_idx"
  ON "bookings" ("status", "end_time");

CREATE INDEX "bookings_user_id_crid_rid_status_start_time_idx"
  ON "bookings" ("user_id", "community_resource_id", "resource_id", "status", "start_time");

-- NOTE:
-- The original EXCLUDE constraint using tstzrange(start_time, end_time)
-- fails on this PostgreSQL setup with:
--   ERROR: functions in index expression must be marked IMMUTABLE (42P17)
-- We keep app-level overlap checks and rely on unique start-time protection
-- (`bookings_resource_id_start_time_pending_active_unique`) for now.
