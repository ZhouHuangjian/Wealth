import { z } from "zod";
import { EVENT_KINDS } from "../shared/analysis-rubric.js";
export const eventSchema = z
  .object({
    kind: z.enum(Object.keys(EVENT_KINDS) as [string, ...string[]]),
    state: z.enum(["active", "resolved", "uncertain"]),
    resolvedByMessageIds: z
      .array(z.string().min(1).max(256))
      .max(6)
      .default([]),
  })
  .strict();
