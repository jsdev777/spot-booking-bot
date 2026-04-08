-- DB-level overlap protection for active/pending reservations on the same resource.
CREATE OR REPLACE FUNCTION enforce_bookings_no_overlap_pending_active()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
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

DROP TRIGGER IF EXISTS bookings_no_overlap_pending_active_trigger ON "bookings";

CREATE TRIGGER bookings_no_overlap_pending_active_trigger
BEFORE INSERT OR UPDATE OF resource_id, start_time, end_time, status
ON "bookings"
FOR EACH ROW
EXECUTE FUNCTION enforce_bookings_no_overlap_pending_active();
