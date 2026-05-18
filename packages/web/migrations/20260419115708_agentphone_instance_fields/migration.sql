-- AlterTable: AgentPhone fields on Instance
ALTER TABLE "Instance"
  ADD COLUMN "phoneNumber" TEXT,
  ADD COLUMN "twilioNumberSid" TEXT,
  ADD COLUMN "phoneCountry" TEXT,
  ADD COLUMN "audioRecordingEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex: phoneNumber unique
CREATE UNIQUE INDEX "Instance_phoneNumber_key" ON "Instance"("phoneNumber");

-- CreateTable: SpamNumber denylist (populated by SaaS edge in Phase 9)
CREATE TABLE "SpamNumber" (
    "phoneNumber" TEXT NOT NULL,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "reason" TEXT,

    CONSTRAINT "SpamNumber_pkey" PRIMARY KEY ("phoneNumber")
);
