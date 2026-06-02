import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import {
  createGithubEvidenceClient,
  createPaperclipEvidenceClient,
  generateEvidencePacket,
} from "../evidencePacket.js";

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

export function registerPaperclipEvidenceRoutes(): void {
  addRoute("POST", "/api/v1/paperclip/evidence-packet", async ({ res, body }) => {
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const issue = requireString(b.issue, "issue");
    const prUrl = typeof b.prUrl === "string" && b.prUrl.trim() ? b.prUrl.trim() : undefined;
    const companyId = typeof b.companyId === "string" && b.companyId.trim() ? b.companyId.trim() : undefined;
    const paperclipOrigin = typeof b.paperclipOrigin === "string" && b.paperclipOrigin.trim()
      ? b.paperclipOrigin.trim()
      : process.env.PAPERCLIP_PUBLIC_URL || undefined;

    const packet = await generateEvidencePacket(
      { issue, prUrl, companyId, paperclipOrigin },
      { paperclip: createPaperclipEvidenceClient(), github: createGithubEvidenceClient() },
    );
    sendJson(res, 200, packet);
  });
}
