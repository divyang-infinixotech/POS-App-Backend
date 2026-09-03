-- ============================================================================
-- Incremental KOT Tracking
-- Tenant-safe / idempotent migration
--
-- IMPORTANT:
-- This migration creates the tracking structure.
-- It does NOT invent historical KOTItem records.
-- ============================================================================


-- ============================================================================
-- 1. Add sentQuantity to OrderItem
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'OrderItem'
          AND column_name = 'sentQuantity'
    ) THEN

        ALTER TABLE "OrderItem"
        ADD COLUMN "sentQuantity" INTEGER NOT NULL DEFAULT 0;

        RAISE NOTICE
            'Added sentQuantity to OrderItem';

    ELSE

        RAISE NOTICE
            'sentQuantity already exists';

    END IF;
END $$;


-- ============================================================================
-- 2. Create KOTItem
-- ============================================================================

CREATE TABLE IF NOT EXISTS "KOTItem" (
    "id" SERIAL NOT NULL,
    "kotId" INTEGER NOT NULL,
    "orderItemId" INTEGER NOT NULL,
    "menuItemId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KOTItem_pkey"
        PRIMARY KEY ("id")
);


-- ============================================================================
-- 3. Indexes
-- ============================================================================

CREATE INDEX IF NOT EXISTS
    "KOTItem_kotId_idx"
ON "KOTItem"("kotId");


CREATE INDEX IF NOT EXISTS
    "KOTItem_orderItemId_idx"
ON "KOTItem"("orderItemId");


CREATE INDEX IF NOT EXISTS
    "KOTItem_kotId_orderItemId_idx"
ON "KOTItem"("kotId", "orderItemId");


-- ============================================================================
-- 4. Foreign keys
--
-- IMPORTANT:
-- Check constraint inside the CURRENT tenant schema.
-- ============================================================================

DO $$
BEGIN

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class t
            ON t.oid = c.conrelid
        JOIN pg_namespace n
            ON n.oid = t.relnamespace
        WHERE c.conname = 'KOTItem_kotId_fkey'
          AND n.nspname = current_schema()
    ) THEN

        ALTER TABLE "KOTItem"
        ADD CONSTRAINT "KOTItem_kotId_fkey"
        FOREIGN KEY ("kotId")
        REFERENCES "KOT"("id")
        ON DELETE CASCADE
        ON UPDATE CASCADE;

    END IF;


    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class t
            ON t.oid = c.conrelid
        JOIN pg_namespace n
            ON n.oid = t.relnamespace
        WHERE c.conname = 'KOTItem_orderItemId_fkey'
          AND n.nspname = current_schema()
    ) THEN

        ALTER TABLE "KOTItem"
        ADD CONSTRAINT "KOTItem_orderItemId_fkey"
        FOREIGN KEY ("orderItemId")
        REFERENCES "OrderItem"("id")
        ON DELETE CASCADE
        ON UPDATE CASCADE;

    END IF;


    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class t
            ON t.oid = c.conrelid
        JOIN pg_namespace n
            ON n.oid = t.relnamespace
        WHERE c.conname = 'KOTItem_menuItemId_fkey'
          AND n.nspname = current_schema()
    ) THEN

        ALTER TABLE "KOTItem"
        ADD CONSTRAINT "KOTItem_menuItemId_fkey"
        FOREIGN KEY ("menuItemId")
        REFERENCES "MenuItem"("id")
        ON UPDATE CASCADE;

    END IF;

END $$;


-- ============================================================================
-- 5. Initialize sentQuantity
--
-- Existing KOT history cannot reliably be reconstructed without KOTItem data.
--
-- Therefore:
-- - Existing orders with existing KOTs:
--     sentQuantity = current quantity
--
-- - Orders with no KOTs:
--     sentQuantity = 0
--
-- This prevents existing items from being sent again after migration.
-- New additions will be calculated correctly.
-- ============================================================================

UPDATE "OrderItem" oi
SET "sentQuantity" = oi."quantity"
WHERE EXISTS (
    SELECT 1
    FROM "KOT" k
    WHERE k."orderId" = oi."orderId"
      AND k."cancelledAt" IS NULL
);


UPDATE "OrderItem" oi
SET "sentQuantity" = 0
WHERE NOT EXISTS (
    SELECT 1
    FROM "KOT" k
    WHERE k."orderId" = oi."orderId"
      AND k."cancelledAt" IS NULL
);


-- ============================================================================
-- END
-- ============================================================================