-- Serialize booking writes per resource to avoid race conditions in overlap check.
CREATE OR REPLACE FUNCTION enforce_bookings_no_overlap_pending_active()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Per-resource transaction lock: prevents two concurrent writes for the same
  -- resource from passing overlap check at the same time.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."resource_id", 0));

  IF NEW.status IN ('PENDING'::"BookingStatus", 'ACTIVE'::"BookingStatus") THEN
    IF EXISTS (
      SELECT 1
      FROM "bookings" b
      WHERE b."resource_id" = NEW."resource_id"
        AND b."status" IN ('PENDING'::"BookingStatus", 'ACTIVE'::"BookingStatus")
        AND b."id" <> NEW."id"
        AND b."start_time" < NEW."end_time"
        AND b."end_time" > NEW."start_time"
    ) THEN
      RAISE EXCEPTION 'bookings_overlap_blocked'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
