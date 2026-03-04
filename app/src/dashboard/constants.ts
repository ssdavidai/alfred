// Shared constants for dashboard components (graph + chart)
// 19 real types from schema.py: 14 entity + 5 learning

/** Color map for all 14 vault entity types + 5 learning types */
export const VAULT_TYPE_COLORS: Record<string, string> = {
  // Entity types (14)
  person: "#B8976A",
  org: "#A89270",
  project: "#6BA8B8",
  task: "#8AB86B",
  event: "#B86B8A",
  note: "#E8E4DE",
  location: "#B8A56B",
  process: "#6BB8A8",
  account: "#7A8AB8",
  asset: "#6B9AB8",
  conversation: "#9AB86B",
  input: "#B88A6B",
  run: "#A0A0A0",
  session: "#C0A880",
  // Learning types (5)
  decision: "#B89F6B",
  assumption: "#B87A6B",
  constraint: "#9F6BB8",
  contradiction: "#B86B9F",
  synthesis: "#6BB89F",
};

/** Agent configuration for graph visualization */
export const AGENT_CONFIG = [
  {
    key: "curator",
    label: "CURATOR",
    color: "#8AB86B",
    preferredTypes: ["input", "note", "conversation"],
  },
  {
    key: "janitor",
    label: "JANITOR",
    color: "#D4A547",
    preferredTypes: ["task", "project", "process", "run"],
  },
  {
    key: "distiller",
    label: "DISTILLER",
    color: "#9F6BB8",
    preferredTypes: ["assumption", "decision", "constraint", "contradiction", "synthesis"],
  },
  {
    key: "surveyor",
    label: "SURVEYOR",
    color: "#6BA8B8",
    preferredTypes: ["person", "org", "event", "location"],
  },
] as const;
