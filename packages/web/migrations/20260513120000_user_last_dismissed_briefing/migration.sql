-- AlterTable: track which briefing the principal has most recently
-- dismissed via the /desk envelope "Continue" button. NULL on existing
-- rows means "never dismissed any" — the envelope shows for the first
-- briefing they encounter, then this column is bumped to that slug-date.
-- When a newer briefing arrives the envelope reappears (slug_date diff).
-- See packages/saas/app/src/briefings/operations.ts.
ALTER TABLE "User"
  ADD COLUMN "lastDismissedBriefingSlugDate" TEXT;
