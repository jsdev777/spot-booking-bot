-- Legacy DBs may still have name_ru; schema expects name_ua. Fresh installs already have name_ua.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'sport_kinds'
      AND column_name = 'name_ru'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'sport_kinds'
      AND column_name = 'name_ua'
  ) THEN
    ALTER TABLE "sport_kinds" RENAME COLUMN "name_ru" TO "name_ua";
  END IF;
END $$;
