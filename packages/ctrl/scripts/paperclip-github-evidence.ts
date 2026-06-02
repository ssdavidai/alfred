#!/usr/bin/env node
import { createGithubEvidenceClient, createPaperclipEvidenceClient, generateEvidencePacket } from "../src/api/evidencePacket.js";

function usage() {
  console.error(`Usage: npx tsx scripts/paperclip-github-evidence.ts --issue ALFA-23 [--pr https://github.com/org/repo/pull/1] [--company-id UUID] [--json]\n\nRequires PAPERCLIP_API_KEY for live Paperclip reads. GitHub public PRs work unauthenticated; set GITHUB_TOKEN only if rate-limited.`);
}

const args = process.argv.slice(2);
let issue = "";
let prUrl;
let companyId;
let json = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--issue") issue = args[++i] || "";
  else if (a === "--pr") prUrl = args[++i];
  else if (a === "--company-id") companyId = args[++i];
  else if (a === "--json") json = true;
  else if (a === "--help" || a === "-h") { usage(); process.exit(0); }
  else { console.error(`Unknown argument: ${a}`); usage(); process.exit(2); }
}

if (!issue) { usage(); process.exit(2); }

const packet = await generateEvidencePacket(
  { issue, prUrl, companyId, paperclipOrigin: process.env.PAPERCLIP_PUBLIC_URL },
  { paperclip: createPaperclipEvidenceClient(), github: createGithubEvidenceClient() },
);

console.log(json ? JSON.stringify(packet, null, 2) : packet.text);
