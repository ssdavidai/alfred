import fs from "node:fs";
import path from "node:path";
import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError } from "../errors.js";

const WORKSPACE_DIR = "/mnt/encrypted/openclaw/workspace";
const ALLOWED_FILES = new Set(["SOUL.md", "USER.md", "MEMORY.md", "AGENTS.md", "TOOLS.md", "KNOWN_CONTACTS.md"]);

function validateFilename(filename: string): void {
  if (!filename || !ALLOWED_FILES.has(filename)) {
    throw new ValidationError(`Invalid workspace file: ${filename}. Allowed: ${[...ALLOWED_FILES].join(", ")}`);
  }
}

export function registerWorkspaceRoutes(): void {
  // Read a workspace file
  addRoute("GET", "/api/v1/admin/workspace/:filename", async ({ res, params }) => {
    validateFilename(params.filename);
    const filePath = path.join(WORKSPACE_DIR, params.filename);
    let content = "";
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch (err: any) {
      if (err.code === "ENOENT") {
        // File doesn't exist yet — return empty content (not an error)
        sendJson(res, 200, { filename: params.filename, content: "" });
        return;
      }
      throw err;
    }
    sendJson(res, 200, { filename: params.filename, content });
  });

  // Write a workspace file
  addRoute("PUT", "/api/v1/admin/workspace/:filename", async ({ res, params, body }) => {
    validateFilename(params.filename);
    const b = body as { content?: string } | undefined;
    if (!b || typeof b.content !== "string") {
      throw new ValidationError("Request body must include 'content' (string)");
    }

    // Ensure workspace directory exists
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    const filePath = path.join(WORKSPACE_DIR, params.filename);
    fs.writeFileSync(filePath, b.content, "utf-8");
    sendJson(res, 200, { filename: params.filename, message: "File saved" });
  });
}
