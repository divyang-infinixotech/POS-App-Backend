-- ─────────────────────────────────────────────────────────────────────────────
-- Manual-review OnboardingStatus values (new simplified onboarding flow)
--
-- The new flow is: PLAN → REVIEW → SUBMIT → MANUAL_PENDING → SUPER_ADMIN
-- reviews → generates payment QR → marks payment received → approves.
-- No payment is collected during onboarding, so the application moves through
-- these MANUAL_* stages instead of the Razorpay PAYMENT_* stages.
--
-- Every statement is guarded (pg_enum checks) so re-applying this migration on
-- a database that already received the DDL is a no-op.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── OnboardingStatus: manual-review lifecycle values ──────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'OnboardingStatus' AND e.enumlabel = 'MANUAL_PENDING') THEN
    ALTER TYPE "OnboardingStatus" ADD VALUE 'MANUAL_PENDING';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'OnboardingStatus' AND e.enumlabel = 'MANUAL_PAYMENT_PENDING') THEN
    ALTER TYPE "OnboardingStatus" ADD VALUE 'MANUAL_PAYMENT_PENDING';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'OnboardingStatus' AND e.enumlabel = 'MANUAL_PAYMENT_RECEIVED') THEN
    ALTER TYPE "OnboardingStatus" ADD VALUE 'MANUAL_PAYMENT_RECEIVED';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'OnboardingStatus' AND e.enumlabel = 'MANUAL_APPROVED') THEN
    ALTER TYPE "OnboardingStatus" ADD VALUE 'MANUAL_APPROVED';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'OnboardingStatus' AND e.enumlabel = 'MANUAL_REJECTED') THEN
    ALTER TYPE "OnboardingStatus" ADD VALUE 'MANUAL_REJECTED';
  END IF;
END $$;