import { spawn } from "node:child_process";
import { addRoute } from "../server.js";
import { ValidationError } from "../errors.js";
import { COMPOSE_DIR } from "../helpers.js";

export function registerLogRoutes(): void {
  // SSE log streaming via child_process.spawn
  addRoute("GET", "/api/v1/logs", async ({ req, res, query }) => {
    const service = query.get("service") ?? "";
    const tail = query.get("tail") ?? "100";

    if (service && !/^[a-zA-Z0-9_-]+$/.test(service)) {
      throw new ValidationError("Invalid service name");
    }
    if (!/^\d+$/.test(tail)) {
      throw new ValidationError("tail must be a number");
    }

    const args = [
      "compose", "-f", `${COMPOSE_DIR}/docker-compose.yaml`,
      "logs", "--tail", tail, "-f",
    ];
    if (service) args.push(service);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });

    let buffer = "";
    const flush = (data: string) => {
      buffer += data;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line) {
          res.write(`data: ${JSON.stringify({ line })}\n\n`);
        }
      }
    };

    child.stdout.on("data", (data: Buffer) => flush(data.toString()));
    child.stderr.on("data", (data: Buffer) => flush(data.toString()));

    child.on("close", () => {
      if (buffer) {
        res.write(`data: ${JSON.stringify({ line: buffer })}\n\n`);
      }
      res.write("event: close\ndata: {}\n\n");
      res.end();
    });

    child.on("error", (err) => {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    });

    req.on("close", () => {
      child.kill("SIGTERM");
    });
  });
}
