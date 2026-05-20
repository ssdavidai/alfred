import type { ServerResponse } from "node:http";

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export class AuthError extends ApiError {
  constructor(message = "Unauthorized") {
    super(401, "UNAUTHORIZED", message);
  }
}

export class ValidationError extends ApiError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(400, "VALIDATION_ERROR", message, details);
  }
}

export class NotFoundError extends ApiError {
  constructor(message = "Not found") {
    super(404, "NOT_FOUND", message);
  }
}

export class ConflictError extends ApiError {
  constructor(message: string) {
    super(409, "CONFLICT", message);
  }
}

export class ExecError extends ApiError {
  /** Captured stdout from the failed subprocess (best-effort). */
  public stdout?: string;
  /** Captured stderr from the failed subprocess (best-effort). */
  public stderr?: string;

  constructor(message: string, stderr?: string, stdout?: string) {
    const details: Record<string, unknown> = {};
    if (stderr) details.stderr = stderr;
    if (stdout) details.stdout = stdout;
    super(500, "EXEC_ERROR", message, Object.keys(details).length ? details : undefined);
    this.stderr = stderr;
    this.stdout = stdout;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

export function handleError(res: ServerResponse, err: unknown): void {
  if (err instanceof ApiError) {
    sendJson(res, err.statusCode, {
      error: { code: err.code, message: err.message, details: err.details },
    });
  } else {
    const message = err instanceof Error ? err.message : "Internal server error";
    sendJson(res, 500, {
      error: { code: "INTERNAL_ERROR", message },
    });
  }
}
