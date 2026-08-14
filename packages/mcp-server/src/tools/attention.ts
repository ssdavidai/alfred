// NAR (Net Attention Returned) MCP tools — read-only.
//
// Surfaces the statement and stats endpoints implemented in parallel by Lane I.
// These tools return nothing useful until the Lane I API and the backfill land;
// a 404 or empty-but-valid response from a day with no recap data is correct.
//
// Frozen API contract (from the dispatch brief):
//   GET /api/v1/attention/statement?date=YYYY-MM-DD
//   GET /api/v1/attention/statement?from=YYYY-MM-DD&to=YYYY-MM-DD
//   GET /api/v1/attention/stats?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Method: docs/design/nar-method.md. Descriptions follow its integrity rules.
// Alfred quoting its own NAR is the most self-serving thing this system does;
// these descriptions make the model cautious, not enthusiastic.

import { z } from "zod";
import type { ToolDef } from "./types.js";

// YYYY-MM-DD format guard. Calendar validity is enforced by the backend.
const DateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format");

const attentionTools: ToolDef[] = [
  {
    name: "get_attention_statement",
    description:
      "Return the NAR (Net Attention Returned) statement for a single day or a date range — the same figures the /attention dashboard shows. " +
      "Pass `date` for a single day, or both `from` + `to` (inclusive, YYYY-MM-DD) for a range. They are mutually exclusive.\n\n" +
      "FORMULA: NAR = displaced − engaged − interruption. Never blend the three displacement sources.\n\n" +
      "THREE DISPLACEMENT SOURCES — always report separately:\n" +
      "  • explicit: rate-card actions (countable, exact).\n" +
      "  • inferred: estimated from session size buckets (S=5 min, M=20, L=60, XL=120). " +
      "ESTIMATES — always label them as such. Never quote an inferred figure as a fact.\n" +
      "  • autonomous: unattended work counted by artifact produced, not activity. " +
      "One busy day can make 7,000 tool calls and produce two artifacts — credit the artifacts.\n\n" +
      "UNRATED CLASSES: `unrated[]` lists action classes with no rate. They contribute nothing. Name them.\n\n" +
      "ENGAGED: principal-originated events clustered at 10-min gap / 2-min floor. " +
      "Higher engaged HURTS NAR — it is the cost of supervision.\n\n" +
      "INTEGRITY RULES (docs/design/nar-method.md):\n" +
      "  • A defensible small number beats an impressive one.\n" +
      "  • Inferred lines are labelled as estimates.\n" +
      "  • No baseline, no claim — an unrated class says so.\n" +
      "  • A failed session costs full engaged time and zero displacement.\n\n" +
      "A day with no recap data returns nar_hours: 0 with empty arrays. " +
      "Do NOT report that as the real NAR — say the data is absent.",
    inputSchema: z
      .object({
        date: DateStr.optional().describe(
          "Single day (YYYY-MM-DD). Mutually exclusive with `from`/`to`.",
        ),
        from: DateStr.optional().describe(
          "Range start inclusive (YYYY-MM-DD). Requires `to`. Mutually exclusive with `date`.",
        ),
        to: DateStr.optional().describe(
          "Range end inclusive (YYYY-MM-DD). Requires `from`. Mutually exclusive with `date`.",
        ),
      })
      .superRefine((v, ctx) => {
        const hasDate = Boolean(v.date);
        const hasFrom = Boolean(v.from);
        const hasTo = Boolean(v.to);
        if (hasDate && (hasFrom || hasTo)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "`date` and `from`/`to` are mutually exclusive — pass one or the other, not both.",
          });
          return;
        }
        if (!hasDate && !hasFrom && !hasTo) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Pass either `date` (single day) or both `from` and `to` (range).",
          });
          return;
        }
        if (!hasDate && hasFrom && !hasTo) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "`to` is required when `from` is set." });
        }
        if (!hasDate && !hasFrom && hasTo) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["from"], message: "`from` is required when `to` is set." });
        }
      }),
    buildRequest: ({ date, from, to }) => ({
      method: "GET",
      path: "/api/v1/attention/statement",
      query: date ? { date } : { from, to },
    }),
  },
  {
    name: "get_attention_stats",
    description:
      "Return aggregate NAR statistics over a date range — averages, totals, and a per-day `series`. " +
      "Both `from` and `to` (inclusive, YYYY-MM-DD) are required.\n\n" +
      "Same integrity rules as `get_attention_statement`: inferred figures are estimates; " +
      "unrated classes contribute nothing and are named; NAR = displaced − engaged − interruption.\n\n" +
      "Days with no recap data appear as zeros in the series — note how many days have data " +
      "before quoting a weekly or monthly average. A range mostly zeros is not yet meaningful.",
    inputSchema: z.object({
      from: DateStr.describe("Range start inclusive (YYYY-MM-DD)."),
      to: DateStr.describe("Range end inclusive (YYYY-MM-DD)."),
    }),
    buildRequest: ({ from, to }) => ({
      method: "GET",
      path: "/api/v1/attention/stats",
      query: { from, to },
    }),
  },
];

export const ALL_ATTENTION_TOOLS: ToolDef[] = attentionTools;
