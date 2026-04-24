export type SessionEvent = {
  timestamp: number;
  url: string;
  domain: string;
  title: string;
  event_type: string;
};

export type Visit = {
  start: number;
  duration_sec: number;
  domain: string;
  title: string;
  url: string;
};

export const ANALYZE_SYSTEM_PROMPT = `You are Echooo, a workflow analyst. You look at a user's browser session log and identify repeated workflows, draft SOPs, and generate contextualized Claude prompts that let a non-technical teammate delegate that workflow to AI.

You will receive a JSON array of "visits" — compressed tab activity across a work session.

Your job: identify REPEATED workflows (a sequence of domains that occurred 2+ times). For each, output a strict JSON object matching the schema below.

Be conservative about inferred rules — only state a rule if you have 3+ examples supporting it, and flag uncertainty. A hallucinated rule is worse than no rule.

For the "ready_prompt" field: write a COMPLETE Claude prompt the user can paste into claude.ai. It should include (a) the role/goal, (b) the workflow context you inferred, (c) any decision rules, (d) the expected output format. Assume the user will feed it a fresh instance of the task.

For "ai_leverage": for each step (referenced by step_index, 0-indexed into the steps array), classify as "automatable" (strong LLM task — email parsing, classification, summarization, structured extraction), "deterministic" (a simple script or API call beats an LLM), or "judgment" (requires human discretion). Include a one-sentence "why".

If no clear repeated workflows exist (fewer than 2 occurrences of any sequence), return an empty "workflows" array and say so in the summary.

Output ONLY valid JSON matching this EXACT schema. No extra fields, no prose, no markdown fences:

{
  "workflows": [
    {
      "name": "string (short, human-readable — e.g. 'Customer refund processing')",
      "occurrences": number,
      "avg_duration_min": number,
      "steps": [
        { "domain": "string", "action": "string (one sentence)" }
      ],
      "ai_leverage": [
        {
          "step_index": number,
          "verdict": "automatable" | "deterministic" | "judgment",
          "why": "string (one sentence)"
        }
      ],
      "inferred_rules": ["string (only high-confidence rules, empty array if none)"],
      "ready_prompt": "string (a complete, paste-ready Claude prompt)"
    }
  ],
  "summary": "string (1-2 sentences describing what was detected)"
}

Use ONLY these field names. Do not add "id", "order", "occurrence_timestamps", "title_pattern", "decision_rules", "avg_duration_sec", or any other fields.`;

export const buildUserPrompt = (visits: Visit[]): string =>
  `Here is my browser session (${visits.length} compressed visits):\n\n${JSON.stringify(
    visits,
    null,
    2,
  )}\n\nIdentify repeated workflows and produce the analysis.`;

export const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    workflows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          occurrences: { type: "integer" },
          avg_duration_min: { type: "number" },
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                domain: { type: "string" },
                action: { type: "string" },
              },
              required: ["domain", "action"],
              additionalProperties: false,
            },
          },
          ai_leverage: {
            type: "array",
            items: {
              type: "object",
              properties: {
                step_index: { type: "integer" },
                verdict: {
                  type: "string",
                  enum: ["automatable", "deterministic", "judgment"],
                },
                why: { type: "string" },
              },
              required: ["step_index", "verdict", "why"],
              additionalProperties: false,
            },
          },
          inferred_rules: {
            type: "array",
            items: { type: "string" },
          },
          ready_prompt: { type: "string" },
        },
        required: [
          "name",
          "occurrences",
          "avg_duration_min",
          "steps",
          "ai_leverage",
          "inferred_rules",
          "ready_prompt",
        ],
        additionalProperties: false,
      },
    },
    summary: { type: "string" },
  },
  required: ["workflows", "summary"],
  additionalProperties: false,
} as const;
