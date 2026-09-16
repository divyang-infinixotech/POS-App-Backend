-- ─── Case-insensitive email identity ─────────────────────────────────────────
-- Emails are now normalized (trim + lowercase) by the application on every
-- write and lookup. This migration makes the DATABASE enforce the same rule so
-- "TEST@EXAMPLE.COM" and "test@example.com" can never become two accounts,
-- even if a code path skips normalization.
--
-- Safety sequence (no blind data changes):
--   1. normalize existing rows (trim + lower)
--   2. verify no case-collisions remain (the DO blocks abort with a clear
--      error listing the conflicting rows if any are found — resolve them by
--      hand before re-running)
--   3. add functional UNIQUE indexes on lower(email)
--
-- The existing case-sensitive unique constraints (User_email_key,
-- Restaurant_email_key) are intentionally KEPT: the functional indexes above
-- them are strictly stricter (they also catch the exact-duplicate case), and
-- keeping them avoids any Prisma schema drift. Only "test@example.com" vs
-- "TEST@EXAMPLE.COM" style pairs collide; distinct addresses like
-- "john.smith@gmail.com" vs "johnsmith@gmail.com" are untouched — no
-- provider-specific dot/+ collapsing is performed anywhere.

-- ─── 1. Normalize existing public.User emails ───
UPDATE "User"
SET "email" = lower(btrim("email"))
WHERE "email" IS NOT NULL
  AND "email" <> lower(btrim("email"));

-- ─── 2. Verify + index public.User ───
-- Two-level aggregation: the inner query groups by lower(email) and counts;
-- the outer query builds the report string. (A nested aggregate like
-- string_agg(lower(email) || count(*)) is invalid in PostgreSQL.)
DO $$
DECLARE
  dup text;
BEGIN
  SELECT string_agg(
    email_group || ' (x' || duplicate_count || ')',
    ', '
  )
  INTO dup
  FROM (
    SELECT
      lower("email") AS email_group,
      count(*) AS duplicate_count
    FROM "User"
    WHERE "email" IS NOT NULL
    GROUP BY lower("email")
    HAVING count(*) > 1
  ) duplicates;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot add case-insensitive unique index on "User": duplicate emails after normalization: % — resolve these rows first', dup;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "User_email_case_insensitive_key"
  ON "User" (lower("email"));

-- ─── 3. Normalize + verify + index Restaurant.email (nullable) ───
UPDATE "Restaurant"
SET "email" = lower(btrim("email"))
WHERE "email" IS NOT NULL
  AND "email" <> lower(btrim("email"));

-- Same two-level aggregation pattern as the User check above.
DO $$
DECLARE
  dup text;
BEGIN
  SELECT string_agg(
    email_group || ' (x' || duplicate_count || ')',
    ', '
  )
  INTO dup
  FROM (
    SELECT
      lower("email") AS email_group,
      count(*) AS duplicate_count
    FROM "Restaurant"
    WHERE "email" IS NOT NULL
    GROUP BY lower("email")
    HAVING count(*) > 1
  ) duplicates;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot add case-insensitive unique index on "Restaurant": duplicate emails after normalization: % — resolve these rows first', dup;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "Restaurant_email_case_insensitive_key"
  ON "Restaurant" (lower("email"))
  WHERE "email" IS NOT NULL;
