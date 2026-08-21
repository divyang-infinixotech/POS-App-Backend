-- Add SWITCH to PlanChangeType — lower-priced/equal-priced plan changes are
-- now immediate purchases (SWITCH) instead of scheduled downgrades.
ALTER TYPE "PlanChangeType" ADD VALUE IF NOT EXISTS 'SWITCH';
