-- Subscription Plan Management Migration
-- 1) Database-driven plans (Plan table) — no hardcoded plan config
-- 2) Append-only SubscriptionHistory for every plan change
-- 3) Extended Subscription snapshot fields (features, limits, billing cycle)
-- 4) Convert Restaurant.subscriptionPlan + Subscription.plan from enum to TEXT
--    so Super Admin can create/edit arbitrary plans.

-- ── 1. New enums ─────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "BillingCycle" AS ENUM ('MONTHLY', 'YEARLY', 'ONCE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PlanChangeType" AS ENUM (
    'CREATION', 'UPGRADE', 'DOWNGRADE', 'RENEWAL',
    'SUSPENSION', 'REACTIVATION', 'CANCELLATION', 'EXPIRATION'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. Convert enum columns to TEXT (values preserved) ───────────────────────
ALTER TABLE "Restaurant"
  ALTER COLUMN "subscriptionPlan" DROP DEFAULT;
ALTER TABLE "Restaurant"
  ALTER COLUMN "subscriptionPlan" SET DATA TYPE TEXT USING "subscriptionPlan"::text;
ALTER TABLE "Restaurant"
  ALTER COLUMN "subscriptionPlan" SET DEFAULT 'TRIAL';

ALTER TABLE "Subscription"
  ALTER COLUMN "plan" DROP DEFAULT;
ALTER TABLE "Subscription"
  ALTER COLUMN "plan" SET DATA TYPE TEXT USING "plan"::text;
ALTER TABLE "Subscription"
  ALTER COLUMN "plan" SET DEFAULT 'TRIAL';

-- Drop the now-unused enum type (only after all referencing columns are TEXT).
-- Best-effort cleanup: ignore any dependent-objects error. NOTE: the PG18-only
-- condition name `dependent_objects_exist` is not recognized by PL/pgSQL here
-- (42704), so we catch OTHERS — the DO block is intentionally best-effort.
DO $$ BEGIN
  DROP TYPE IF EXISTS "SubscriptionPlan";
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- ── 3. Plan table ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Plan" (
  "id"                SERIAL       NOT NULL,
  "code"              TEXT         NOT NULL,
  "name"              TEXT         NOT NULL,
  "description"       TEXT,
  "monthlyPrice"      DOUBLE PRECISION NOT NULL DEFAULT 0,
  "yearlyPrice"       DOUBLE PRECISION NOT NULL DEFAULT 0,
  "billingCycle"      "BillingCycle"   NOT NULL DEFAULT 'MONTHLY',
  "trialDays"         INTEGER      NOT NULL DEFAULT 15,
  "maxUsers"          INTEGER,
  "maxTables"         INTEGER,
  "maxFloors"         INTEGER,
  "maxMenuItems"      INTEGER,
  "maxPrinters"       INTEGER,
  "maxBranches"       INTEGER,
  "maxOrdersPerMonth" INTEGER,
  "storageLimitMB"    INTEGER,
  "features"          JSONB        NOT NULL DEFAULT '[]',
  "isActive"          BOOLEAN      NOT NULL DEFAULT true,
  "isDefault"         BOOLEAN      NOT NULL DEFAULT false,
  "sortOrder"         INTEGER      NOT NULL DEFAULT 0,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Plan_code_key" ON "Plan"("code");
CREATE INDEX IF NOT EXISTS "Plan_isActive_idx" ON "Plan"("isActive");
CREATE INDEX IF NOT EXISTS "Plan_code_idx" ON "Plan"("code");

-- ── 4. Extend Subscription table ─────────────────────────────────────────────
ALTER TABLE "Subscription"
  ADD COLUMN IF NOT EXISTS "planId"            INTEGER,
  ADD COLUMN IF NOT EXISTS "nextRenewalDate"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "billingCycle"      TEXT NOT NULL DEFAULT 'MONTHLY',
  ADD COLUMN IF NOT EXISTS "maxFloors"         INTEGER,
  ADD COLUMN IF NOT EXISTS "maxPrinters"       INTEGER,
  ADD COLUMN IF NOT EXISTS "maxBranches"       INTEGER,
  ADD COLUMN IF NOT EXISTS "storageLimitMB"    INTEGER,
  ADD COLUMN IF NOT EXISTS "features"          JSONB,
  ADD COLUMN IF NOT EXISTS "updatedBy"         INTEGER,
  ADD COLUMN IF NOT EXISTS "cancelledAt"       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "cancelledReason"   TEXT;

-- Limits become nullable (Plan may allow unlimited)
ALTER TABLE "Subscription" ALTER COLUMN "maxUsers"     DROP NOT NULL;
ALTER TABLE "Subscription" ALTER COLUMN "maxTables"    DROP NOT NULL;
ALTER TABLE "Subscription" ALTER COLUMN "maxMenuItems" DROP NOT NULL;

ALTER TABLE "Subscription"
  ADD CONSTRAINT "Subscription_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "Subscription_planId_idx" ON "Subscription"("planId");

-- ── 5. SubscriptionHistory table (append-only) ───────────────────────────────
CREATE TABLE IF NOT EXISTS "SubscriptionHistory" (
  "id"             SERIAL        NOT NULL,
  "restaurantId"   INTEGER       NOT NULL,
  "changeType"     "PlanChangeType" NOT NULL,
  "previousPlanId" INTEGER,
  "newPlanId"      INTEGER,
  "previousPlan"   TEXT,
  "newPlan"        TEXT,
  "previousStatus" TEXT,
  "newStatus"      TEXT,
  "billingCycle"   TEXT,
  "amount"         DOUBLE PRECISION,
  "expiryDate"     TIMESTAMP(3),
  "changedBy"      INTEGER,
  "notes"          TEXT,
  "ipAddress"      TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SubscriptionHistory_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "SubscriptionHistory"
  ADD CONSTRAINT "SubscriptionHistory_restaurantId_fkey"
  FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubscriptionHistory"
  ADD CONSTRAINT "SubscriptionHistory_previousPlanId_fkey"
  FOREIGN KEY ("previousPlanId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SubscriptionHistory"
  ADD CONSTRAINT "SubscriptionHistory_newPlanId_fkey"
  FOREIGN KEY ("newPlanId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "SubscriptionHistory_restaurantId_idx" ON "SubscriptionHistory"("restaurantId");
CREATE INDEX IF NOT EXISTS "SubscriptionHistory_changeType_idx"  ON "SubscriptionHistory"("changeType");
CREATE INDEX IF NOT EXISTS "SubscriptionHistory_createdAt_idx"   ON "SubscriptionHistory"("createdAt");

-- ── 6. Seed default plans (idempotent) ───────────────────────────────────────
INSERT INTO "Plan"
  ("code","name","description","monthlyPrice","yearlyPrice","billingCycle","trialDays",
   "maxUsers","maxTables","maxFloors","maxMenuItems","maxPrinters","maxBranches","maxOrdersPerMonth","storageLimitMB",
   "features","isActive","isDefault","sortOrder","createdAt","updatedAt")
VALUES
  ('TRIAL', 'Trial', 'Free 15-day trial to explore the platform.', 0, 0, 'MONTHLY', 15,
   5, 20, 1, 100, 1, 1, 1000, 100,
   '["pos","menu","billing","tables","active_orders"]', true, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('BASIC', 'Basic', 'For small single-outlet restaurants.', 999, 9990, 'MONTHLY', 0,
   10, 30, 2, 250, 2, 1, 5000, 500,
   '["pos","menu","billing","tables","active_orders","kitchen","staff","customers","reports"]', true, false, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('PRO', 'Professional', 'For growing restaurants with advanced needs.', 2499, 24990, 'MONTHLY', 0,
   25, 75, 5, 1000, 5, 3, NULL, 2000,
   '["pos","menu","billing","tables","active_orders","kitchen","staff","customers","reports","floors","inventory","multi_printer"]', true, false, 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('PREMIUM', 'Premium', 'For multi-branch establishments.', 9999, 99990, 'YEARLY', 0,
   100, 300, 10, NULL, 10, 10, NULL, 10000,
   '["pos","menu","billing","tables","active_orders","kitchen","staff","customers","reports","floors","inventory","multi_printer","analytics","online_ordering"]', true, false, 4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ENTERPRISE', 'Enterprise', 'Unlimited everything with dedicated support.', 0, 0, 'YEARLY', 0,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
   '["pos","menu","billing","tables","active_orders","kitchen","staff","customers","reports","floors","inventory","multi_printer","analytics","online_ordering","multi_branch"]', true, false, 5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

-- ── 7. Backfill existing subscriptions with plan FK + renewal metadata ───────
UPDATE "Subscription" s
  SET "planId"          = p."id",
      "billingCycle"    = CASE WHEN p."code" = 'TRIAL' THEN 'MONTHLY'
                               WHEN p."billingCycle" = 'YEARLY' THEN 'YEARLY'
                               ELSE 'MONTHLY' END
  FROM "Plan" p
  WHERE s."plan" = p."code" AND s."planId" IS NULL;

UPDATE "Subscription" SET "nextRenewalDate" = "expiryDate" WHERE "nextRenewalDate" IS NULL;

-- ── 8. Fix pre-existing drift: SystemSetting key unique index ────────────────
-- The SystemSetting table predates the migration history (created outside the
-- migration chain), so a fresh replay has no table to index. Creating it here
-- (IF NOT EXISTS — a no-op on databases that already have it) makes the full
-- history replayable on a clean deployment database.
CREATE TABLE IF NOT EXISTS "SystemSetting" (
  "id"        SERIAL       NOT NULL,
  "key"       TEXT         NOT NULL,
  "value"     JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SystemSetting_key_key" ON "SystemSetting"("key");
