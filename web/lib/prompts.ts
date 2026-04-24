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

export type SavedSOP = {
  id: string;
  name: string;
  steps: { domain: string; action: string }[];
  ai_leverage: { step_index: number; verdict: string; why: string }[];
  inferred_rules: string[];
  ready_prompt: string;
  saved_at: number;
  last_verified_at: number;
};

export const ANALYZE_SYSTEM_PROMPT = `You are Echooo, a workflow analyst. You look at a user's browser session log and identify repeated workflows, draft SOPs, and generate contextualized Claude prompts that let a non-technical teammate delegate that workflow to AI.

You will receive a JSON array of "visits" — compressed tab activity across a work session. You may also receive an "existing_wiki" array — SOPs the user saved previously — and must classify each detected workflow against it (see WIKI AWARENESS below).

Your job: identify REPEATED workflows (a sequence of domains that occurred 2+ times). For each, output a strict JSON object matching the schema below.

Be conservative about inferred rules — only state a rule if you have 3+ examples supporting it, and flag uncertainty. A hallucinated rule is worse than no rule.

For the "ready_prompt" field: write a COMPLETE Claude prompt the user can paste into claude.ai. It should include (a) the role/goal, (b) the workflow context you inferred, (c) any decision rules, (d) the expected output format. Assume the user will feed it a fresh instance of the task.

For "ai_leverage": for each step (referenced by step_index, 0-indexed into the steps array), classify as "automatable" (strong LLM task — email parsing, classification, summarization, structured extraction), "deterministic" (a simple script or API call beats an LLM), or "judgment" (requires human discretion). Include a one-sentence "why".

If no clear repeated workflows exist (fewer than 2 occurrences of any sequence), return an empty "workflows" array and say so in the summary.

WIKI AWARENESS:

For each workflow you detect, classify its relationship to the existing_wiki array:

- status: "new" → No matching SOP in the wiki. Set matched_sop_id = null, diff_summary = null.
- status: "updated" → A matching SOP exists but observed behavior has meaningfully changed. Set matched_sop_id to the "id" from the matched wiki entry. diff_summary is a 1–3 item array of human-meaningful changes.
- status: "unchanged" → A matching SOP exists and observed behavior matches it. Set matched_sop_id to the "id". Set diff_summary = null.

MATCHING RULES:
- Matching is semantic, not textual. "Customer refund processing" and "Refund handling" are the same workflow if their domain sequence and intent match.
- Use the SOP name AND step sequence AND domains together for matching. Do not match on name alone.
- Require meaningful domain overlap (at least half the saved SOP's distinct domains appear in the detected workflow) before matching.
- Be conservative. If unsure whether two workflows are the same, mark the detection as "new" rather than create drift noise.

DIFF RULES:
- A change counts only if a human would care. Tab-title wording differences don't count. Step-ordering changes, added/removed domains, added/removed actions, and changed decision thresholds all count.
- Each diff_summary entry reads like a changelog bullet for a teammate — not "step 2 differs" but "Now includes a fraud-check step at dashboard.stripe.com/radar before locating the charge."
- Maximum 3 bullets. If more changes exist, pick the 3 most impactful.
- Only include diff_summary entries you can point to specific evidence for in the new session's visits. If you can't point to evidence, drop the bullet.

If existing_wiki is missing or empty, mark every workflow as "new" with matched_sop_id = null and diff_summary = null.

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
      "ready_prompt": "string (a complete, paste-ready Claude prompt)",
      "status": "new" | "updated" | "unchanged",
      "matched_sop_id": "string or null",
      "diff_summary": ["string"] | null
    }
  ],
  "summary": "string (1-2 sentences describing what was detected)"
}

Use ONLY these field names. Do not add "id", "order", "occurrence_timestamps", "title_pattern", "decision_rules", "avg_duration_sec", or any other fields.`;

export const buildUserPrompt = (
  visits: Visit[],
  existingWiki?: SavedSOP[],
): string => {
  const parts = [
    `Here is my browser session (${visits.length} compressed visits):`,
    "",
    JSON.stringify(visits, null, 2),
  ];

  if (existingWiki && existingWiki.length > 0) {
    parts.push(
      "",
      `Here is my existing_wiki (${existingWiki.length} saved SOPs). Classify each detected workflow against these — match by intent + domain sequence, not name alone:`,
      "",
      JSON.stringify(existingWiki, null, 2),
    );
  } else {
    parts.push("", "existing_wiki is empty — mark every detected workflow as new.");
  }

  parts.push("", "Identify repeated workflows and produce the analysis.");
  return parts.join("\n");
};

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
          status: {
            type: "string",
            enum: ["new", "updated", "unchanged"],
          },
          matched_sop_id: { type: ["string", "null"] },
          diff_summary: {
            anyOf: [{ type: "null" }, { type: "array", items: { type: "string" } }],
          },
        },
        required: [
          "name",
          "occurrences",
          "avg_duration_min",
          "steps",
          "ai_leverage",
          "inferred_rules",
          "ready_prompt",
          "status",
          "matched_sop_id",
          "diff_summary",
        ],
        additionalProperties: false,
      },
    },
    summary: { type: "string" },
  },
  required: ["workflows", "summary"],
  additionalProperties: false,
} as const;
