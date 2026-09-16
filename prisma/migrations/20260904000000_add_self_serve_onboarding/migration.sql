-- ─────────────────────────────────────────────────────────────────────────────
-- Self-serve restaurant onboarding (public registration flow)
--
-- Additive, guarded migration:
--   * new BusinessType values (BAKERY / HOTEL / FOOD_COURT)
--   * new OnboardingStatus lifecycle values for the self-serve flow
--   * new SubscriptionStatus value PENDING_PAYMENT (plan chosen, pre-verification)
--   * Restaurant columns: legalName, registrationNumber, selfServe, onboardingNote
--
-- Every statement is guarded (IF NOT EXISTS / pg_enum checks) so re-applying
-- this migration on a database that already received the DDL is a no-op.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── BusinessType: add new business types ───────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'BusinessType' AND e.enumlabel = 'BAKERY') THEN
    ALTER TYPE "BusinessType" ADD VALUE 'BAKERY';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'BusinessType' AND e.enumlabel = 'HOTEL') THEN
    ALTER TYPE "BusinessType" ADD VALUE 'HOTEL';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'BusinessType' AND e.enumlabel = 'FOOD_COURT') THEN
    ALTER TYPE "BusinessType" ADD VALUE 'FOOD_COURT';
  END IF;
END $$;

-- ─── OnboardingStatus: self-serve lifecycle values ──────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'OnboardingStatus' AND e.enumlabel = 'PLAN_PENDING') THEN
    ALTER TYPE "OnboardingStatus" ADD VALUE 'PLAN_PENDING';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'OnboardingStatus' AND e.enumlabel = 'REGISTERED') THEN
    ALTER TYPE "OnboardingStatus" ADD VALUE 'REGISTERED';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'OnboardingStatus' AND e.enumlabel = 'ONBOARDING') THEN
    ALTER TYPE "OnboardingStatus" ADD VALUE 'ONBOARDING';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'OnboardingStatus' AND e.enumlabel = 'DOCUMENTS_PENDING') THEN
    ALTER TYPE "OnboardingStatus" ADD VALUE 'DOCUMENTS_PENDING';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'OnboardingStatus' AND e.enumlabel = 'LEGAL_PENDING') THEN
    ALTER TYPE "OnboardingStatus" ADD VALUE 'LEGAL_PENDING';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'OnboardingStatus' AND e.enumlabel = 'PLAN_SELECTED') THEN
    ALTER TYPE "OnboardingStatus" ADD VALUE 'PLAN_SELECTED';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'OnboardingStatus' AND e.enumlabel = 'PAYMENT_PENDING') THEN
    ALTER TYPE "OnboardingStatus" ADD VALUE 'PAYMENT_PENDING';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'OnboardingStatus' AND e.enumlabel = 'PAYMENT_SUCCESS') THEN
    ALTER TYPE "OnboardingStatus" ADD VALUE 'PAYMENT_SUCCESS';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'OnboardingStatus' AND e.enumlabel = 'UNDER_REVIEW') THEN
    ALTER TYPE "OnboardingStatus" ADD VALUE 'UNDER_REVIEW';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'OnboardingStatus' AND e.enumlabel = 'PROVISIONING') THEN
    ALTER TYPE "OnboardingStatus" ADD VALUE 'PROVISIONING';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'OnboardingStatus' AND e.enumlabel = 'PAYMENT_FAILED') THEN
    ALTER TYPE "OnboardingStatus" ADD VALUE 'PAYMENT_FAILED';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'OnboardingStatus' AND e.enumlabel = 'DOCUMENT_REJECTED') THEN
    ALTER TYPE "OnboardingStatus" ADD VALUE 'DOCUMENT_REJECTED';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'OnboardingStatus' AND e.enumlabel = 'SUSPENDED') THEN
    ALTER TYPE "OnboardingStatus" ADD VALUE 'SUSPENDED';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'OnboardingStatus' AND e.enumlabel = 'EXPIRED') THEN
    ALTER TYPE "OnboardingStatus" ADD VALUE 'EXPIRED';
  END IF;
END $$;

-- ─── SubscriptionStatus: PENDING_PAYMENT ────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'SubscriptionStatus' AND e.enumlabel = 'PENDING_PAYMENT') THEN
    ALTER TYPE "SubscriptionStatus" ADD VALUE 'PENDING_PAYMENT';
  END IF;
END $$;

-- ─── Restaurant: self-serve onboarding columns ──────────────────────────────
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "legalName" TEXT;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "registrationNumber" TEXT;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "selfServe" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "onboardingNote" TEXT;
