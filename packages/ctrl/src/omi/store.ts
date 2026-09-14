import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { appendJournal, bindPrincipalChannel } from "../db/alfredJournal.js";
import type { ChatMessage, Connection, TaskMap } from "./model.js";

export const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export function fingerprint(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(fingerprint).join(",") + "]";
  if (v && typeof v === "object")
    return (
      "{" +
      Object.entries(v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => JSON.stringify(k) + ":" + fingerprint(x))
        .join(",") +
      "}"
    );
  return JSON.stringify(v);
}
export class OmiStore {
  constructor(public db: DatabaseSync) {}
  connection(): Connection | undefined {
    return this.db
      .prepare("SELECT * FROM omi_connection WHERE id=1")
      .get() as unknown as Connection | undefined;
  }
  requireConnection(): Connection {
    const c = this.connection();
    if (!c?.enabled) throw new Error("Omi chat is disconnected");
    return c;
  }
  maps(account: string): TaskMap[] {
    return this.db
      .prepare("SELECT * FROM omi_task_map WHERE account_id=?")
      .all(account) as unknown as TaskMap[];
  }
  map(
    account: string,
    taskPath: string,
    remoteId: string | null,
    baseline: unknown,
    conflict: string | null = null,
  ) {
    this.db
      .prepare(
        `INSERT INTO omi_task_map VALUES (?,?,?,?,?) ON CONFLICT(account_id,task_path)
      DO UPDATE SET remote_id=excluded.remote_id, baseline=excluded.baseline, conflict=excluded.conflict`,
      )
      .run(
        account,
        taskPath,
        remoteId,
        baseline ? JSON.stringify(baseline) : null,
        conflict,
      );
  }
  importMessage(c: Connection, m: ChatMessage): boolean {
    if (
      !m.id ||
      !m.text ||
      !["human", "ai"].includes(m.sender) ||
      !Number.isFinite(Date.parse(m.created_at))
    )
      return false;
    if (Date.parse(m.created_at) < Date.parse(c.since)) return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (
        this.db
          .prepare(
            "SELECT 1 FROM omi_message_receipt WHERE account_id=? AND message_id=?",
          )
          .get(c.account_id, m.id)
      ) {
        this.db.exec("COMMIT");
        return false;
      }
      const chat = `main:${c.account_id}`;
      bindPrincipalChannel(this.db, "omi", chat, c.principal_id);
      const entry = appendJournal(this.db, {
        channel: "omi",
        chat_id: chat,
        principal_id: c.principal_id,
        direction: m.sender === "human" ? "inbound" : "outbound",
        message: m.text,
        source_kind: "omi-chat",
        source_ref: `omi:${c.account_id}:${m.id}`,
        status: m.sender === "human" ? "received" : "delivered",
        metadata: {
          provider_message_id: m.id,
          provider_created_at: m.created_at,
        },
      });
      // Preserve provider chronology; this adapter is the controller's sole writer.
      this.db
        .prepare("UPDATE alfred_journal SET ts=? WHERE id=?")
        .run(new Date(m.created_at).toISOString(), entry.id);
      this.db
        .prepare("INSERT INTO omi_message_receipt VALUES (?,?,?)")
        .run(c.account_id, m.id, entry.id);
      this.db.exec("COMMIT");
      return true;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  async command<T>(
    account: string,
    id: string,
    operation: string,
    input: unknown,
    run: () => Promise<T>,
  ): Promise<T> {
    if (!/^[A-Za-z0-9_-]{8,160}$/.test(id))
      throw new Error("request_id must be a stable 8–160 character identifier");
    const hash = digest(fingerprint({ operation, input }));
    const prior = this.db
      .prepare("SELECT * FROM omi_command WHERE account_id=? AND request_id=?")
      .get(account, id) as any;
    if (prior) {
      if (prior.fingerprint !== hash)
        throw new Error("request_id already used for different input");
      if (prior.state === "completed") return JSON.parse(prior.result);
      throw new Error(
        "Outcome uncertain or still pending; reconcile before retrying",
      );
    }
    this.db
      .prepare("INSERT INTO omi_command VALUES (?,?,?,?,?,?,?)")
      .run(
        account,
        id,
        hash,
        operation,
        "pending",
        null,
        new Date().toISOString(),
      );
    try {
      const result = await run();
      this.db
        .prepare(
          "UPDATE omi_command SET state='completed',result=? WHERE account_id=? AND request_id=?",
        )
        .run(JSON.stringify(result), account, id);
      return result;
    } catch (e) {
      this.db
        .prepare(
          "UPDATE omi_command SET state='uncertain' WHERE account_id=? AND request_id=?",
        )
        .run(account, id);
      throw e;
    }
  }
}
