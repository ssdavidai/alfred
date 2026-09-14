export interface TaskFields {
  title: string;
  due_at: string | null;
  completed: boolean;
}
export interface LocalTask extends TaskFields {
  path: string;
}
export interface RemoteTask {
  id: string;
  description: string;
  due_at?: string | null;
  completed: boolean;
}
export interface ChatMessage {
  id: string;
  text: string;
  sender: string;
  created_at: string;
}
export interface Connection {
  account_id: string;
  principal_id: string;
  credential_ref: string;
  enabled: number;
  writes_enabled: number;
  since: string;
  last_sync_at: string | null;
  error: string | null;
}
export interface TaskMap {
  account_id: string;
  task_path: string;
  remote_id: string | null;
  baseline: string | null;
  conflict: string | null;
}
export function fields(t: TaskFields): TaskFields {
  return { title: t.title, due_at: t.due_at, completed: t.completed };
}
export function remoteFields(t: RemoteTask): TaskFields {
  return {
    title: t.description,
    due_at: t.due_at ? new Date(t.due_at).toISOString() : null,
    completed: t.completed,
  };
}
// Three-way, field-level merge. Never guess which simultaneous edit was intended.
export function mergeTask(
  base: TaskFields,
  local: TaskFields,
  remote: TaskFields,
) {
  const merged = { ...local };
  const conflicts: string[] = [];
  for (const k of ["title", "due_at", "completed"] as const) {
    if (local[k] === remote[k]) continue;
    if (local[k] === base[k]) Object.assign(merged, { [k]: remote[k] });
    else if (remote[k] !== base[k]) conflicts.push(k);
  }
  return { merged, conflicts };
}
