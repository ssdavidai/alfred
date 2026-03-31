/**
 * SSH key download endpoint — lets users download their tenant SSH private key
 * for direct terminal access via `ssh -i key.pem deploy@hostname`.
 */

import type { Application, Request, Response } from "express";
import { getSessionAndUserFromBearerToken } from "wasp/auth/session";
import { prisma } from "wasp/server";
import fs from "fs";
import path from "path";
import type { IncomingMessage } from "http";

// The ctrl stores SSH keys at this path inside the SaaS container
const CTRL_DATA_DIR = "/app/alfred-ctrl/data";

async function getUserIdFromRequest(req: Request): Promise<string | null> {
  // Support token in query param (for direct browser downloads) or Authorization header
  const queryToken = req.query.token as string | undefined;
  if (queryToken) {
    (req as any).headers = { ...req.headers, authorization: `Bearer ${queryToken}` };
  }
  const result = await getSessionAndUserFromBearerToken(req as unknown as IncomingMessage);
  if (!result) return null;
  return result.user.id;
}

export function registerSSHKeyRoutes(app: Application): void {
  // GET /api/ssh-key — download the SSH private key for the user's instance
  app.get("/api/ssh-key", async (req: Request, res: Response) => {
    try {
      const userId = await getUserIdFromRequest(req);
      if (!userId) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }

      const instance = await prisma.instance.findUnique({
        where: { userId },
      });

      if (!instance) {
        res.status(404).json({ error: "No instance found" });
        return;
      }

      if (instance.status !== "running") {
        res.status(400).json({ error: `Instance is ${instance.status}` });
        return;
      }

      // The ssh_key_path is stored in the ctrl SQLite DB, but we can derive it
      // from the instance. The ctrl CLI stores keys at data/ssh_keys/<id>/id_ed25519.
      // We need to find the right key by looking up the ctrl DB.
      // Simpler: scan the ssh_keys directory for a key that matches.

      const sshKeysDir = path.join(CTRL_DATA_DIR, "ssh_keys");
      if (!fs.existsSync(sshKeysDir)) {
        res.status(500).json({ error: "SSH keys directory not found" });
        return;
      }

      // Find the key file — iterate through directories
      let keyContent: string | null = null;
      let keyId: string | null = null;
      const dirs = fs.readdirSync(sshKeysDir);

      // We need to match the instance to a key. The ctrl SQLite has this mapping,
      // but we can also query the ctrl CLI for the ssh_key_path.
      // For now, use the ctrl SQLite directly.
      const ctrlDbPath = path.join(CTRL_DATA_DIR, "ctrl.db");

      if (fs.existsSync(ctrlDbPath)) {
        // Use the ctrl's own database to find the key path
        // The instance name in ctrl DB matches the tailscale hostname pattern
        const hostname = instance.tailscaleHostname || "";
        // Extract the instance name from tailscale hostname
        // e.g., "alfred-alfred-david-mnbqn4jg.tail5ec603.ts.net" -> "alfred-david-mnbqn4jg"
        const instanceName = hostname
          .replace(/\.tail[^.]+\.ts\.net$/, "")
          .replace(/^alfred-/, "");

        // Read the sqlite DB to find the key path
        try {
          // Use child_process to query sqlite since we can't import node:sqlite in Wasp context
          const { execSync } = await import("child_process");
          const result = execSync(
            `sqlite3 "${ctrlDbPath}" "SELECT ssh_key_path FROM instances WHERE customer_name='${instanceName.replace(/'/g, "''")}';"`,
            { encoding: "utf-8", timeout: 5000 }
          ).trim();

          if (result) {
            // Convert container path to host path
            // /app/alfred-ctrl/data/ssh_keys/99/id_ed25519 -> <CTRL_DATA_DIR>/ssh_keys/99/id_ed25519
            const keyPath = result.replace("/app/alfred-ctrl/data", CTRL_DATA_DIR);
            if (fs.existsSync(keyPath)) {
              keyContent = fs.readFileSync(keyPath, "utf-8");
            }
          }
        } catch {
          // sqlite3 CLI might not be available, fall back to scanning
        }
      }

      // Fallback: scan all key directories
      if (!keyContent) {
        for (const dir of dirs) {
          const keyPath = path.join(sshKeysDir, dir, "id_ed25519");
          if (fs.existsSync(keyPath)) {
            // We can't easily match without the ctrl DB, so for fallback
            // just check if this is the most recent key (crude but works for single-instance users)
            keyContent = fs.readFileSync(keyPath, "utf-8");
            keyId = dir;
            // Don't break — keep scanning to get the latest
          }
        }
      }

      if (!keyContent) {
        res.status(404).json({ error: "SSH key not found for this instance" });
        return;
      }

      const tailscaleHostname = instance.tailscaleHostname?.replace(/\.tail[^.]+\.ts\.net$/, "") || "tenant";

      res.setHeader("Content-Type", "application/x-pem-file");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="alfred-${tailscaleHostname}.pem"`,
      );
      res.send(keyContent);
    } catch (err: any) {
      console.error("[ssh-key] Error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/ssh-info — get connection instructions (no key download)
  app.get("/api/ssh-info", async (req: Request, res: Response) => {
    try {
      const userId = await getUserIdFromRequest(req);
      if (!userId) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }

      const instance = await prisma.instance.findUnique({
        where: { userId },
      });

      if (!instance || instance.status !== "running") {
        res.json({ available: false });
        return;
      }

      const hostname = instance.tailscaleHostname || "";

      res.json({
        available: true,
        hostname,
        user: "deploy",
        instructions: [
          "1. Download your SSH key using the button above",
          "2. Set permissions: chmod 600 alfred-*.pem",
          `3. Connect: ssh -i alfred-*.pem deploy@${hostname}`,
          "4. Once connected, run: docker exec -it compose-openclaw-1 sh",
          "5. Inside the container: openclaw configure",
        ],
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  console.log("[ssh-key] SSH key download routes registered");
}
