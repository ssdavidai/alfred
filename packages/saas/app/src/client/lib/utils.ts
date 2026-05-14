// Re-export of the client `cn` helper at the conventional `lib/utils` path
// so the redesign-style `import { cn } from "../../lib/utils"` works inside
// AB components and ui/* primitives without needing a path alias.
export { cn } from "../utils";
