-- AlterTable: add status + error fields for AgentMail per-tenant inbox
-- provisioning so the admin UI can surface mint failures without crashing
-- the VM provisioning workflow. Both NULL on existing rows; the worker
-- backfills them whenever it runs an inbox-mint pass for a tenant.
-- See packages/saas/app/src/server/agentmail.ts (issue #686).
ALTER TABLE "Instance"
  ADD COLUMN "agentmailProvisionStatus" TEXT,
  ADD COLUMN "agentmailProvisionError" TEXT;
