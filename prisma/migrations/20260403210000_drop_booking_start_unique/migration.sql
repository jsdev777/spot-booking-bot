-- Variable-length bookings: overlap is enforced in application code
DROP INDEX IF EXISTS "bookings_resource_id_start_time_active_unique";
