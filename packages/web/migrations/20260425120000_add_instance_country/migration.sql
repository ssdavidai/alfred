-- AlterTable: add per-tenant country field that drives Twilio number
-- provisioning (issue #535). ISO-3166-1 alpha-2; default "US" backfills
-- existing rows so the provisioner default stays unchanged.
ALTER TABLE "Instance"
  ADD COLUMN "country" TEXT DEFAULT 'US';
