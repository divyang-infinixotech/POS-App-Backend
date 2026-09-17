-- Additive retail business types: SUPERMARKET / GROCERY / CLOTHING.
-- Pure enum extension — existing rows and enum values are untouched, so every
-- stored business type (Restaurant, Café, Bakery, Bar, Food Truck, Cloud
-- Kitchen, Other, Food Court, Hotel) keeps working unchanged.

-- AlterEnum
ALTER TYPE "BusinessType" ADD VALUE 'SUPERMARKET';
ALTER TYPE "BusinessType" ADD VALUE 'GROCERY';
ALTER TYPE "BusinessType" ADD VALUE 'CLOTHING';
