/**
 * Server-side adapter module — public exports.
 *
 * Matches upstream v0.2.0's `server/index.ts` surface so Paperclip's
 * `adapters/registry.js` can import us at the same names.
 */

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { detectModel } from "./detect-model.js";
export { listSkills, syncSkills, resolveDesiredSkillNames } from "./skills.js";
export { sessionCodec } from "./session-codec.js";
