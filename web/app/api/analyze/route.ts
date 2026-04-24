import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import {
  ANALYZE_SYSTEM_PROMPT,
  buildUserPrompt,
  SessionEvent,
  Visit,
} from "@/lib/prompts";

export const runtime = "nodejs";
export const maxDuration = 60;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

function compressEvents(events: SessionEvent[]): Visit[] {
  if (!Array.isArray(events) || events.length === 0) return [];

  const sorted = [...events]
    .filter((e) => e && e.domain)
    .sort((a, b) => a.timestamp - b.timestamp);
  if (sorted.length === 0) return [];

  // Dedupe consecutive same-domain events within 60s — filters tab-thrash
  // noise while keeping the first event as the visit anchor. Single-tab
  // sessions often fire only 1-2 events, so we don't try to derive visit
  // duration from event spans; we derive it from the gap to the next visit.
  const DEDUPE_WINDOW_MS = 60_000;
  const MIN_VISIT_SEC = 5;
  const TAIL_ASSUMED_SEC = 60;

  const deduped: SessionEvent[] = [];
  for (const e of sorted) {
    const prev = deduped[deduped.length - 1];
    if (
      prev &&
      prev.domain === e.domain &&
      e.timestamp - prev.timestamp <= DEDUPE_WINDOW_MS
    ) {
      continue;
    }
    deduped.push(e);
  }

  // Visit duration = gap to the next distinct-domain event. The final
  // visit has no "next" — assume 60s. Drop any visit under 5s (thrash).
  const visits: Visit[] = [];
  for (let i = 0; i < deduped.length; i++) {
    const e = deduped[i];
    const next = deduped[i + 1];
    const durationSec = next
      ? Math.round((next.timestamp - e.timestamp) / 1000)
      : TAIL_ASSUMED_SEC;
    if (durationSec < MIN_VISIT_SEC) continue;
    visits.push({
      start: e.timestamp,
      duration_sec: Math.max(1, durationSec),
      domain: e.domain,
      title: e.title || "",
      url: e.url || "",
    });
  }

  return visits;
}

function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "ANTHROPIC_API_KEY is not configured on the server." },
        { status: 500, headers: CORS_HEADERS },
      );
    }

    const body = await req.json().catch(() => null);
    if (!body || !Array.isArray(body.session_log)) {
      return NextResponse.json(
        { error: "Request body must include a session_log array." },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    const visits = compressEvents(body.session_log as SessionEvent[]);

    if (visits.length === 0) {
      return NextResponse.json(
        {
          workflows: [],
          summary: "No tab activity was captured in this session.",
        },
        { headers: CORS_HEADERS },
      );
    }

    const client = new Anthropic({ apiKey, maxRetries: 0 });

    // Retry with exponential backoff on transient upstream errors.
    // If the primary model stays overloaded, fall back to Haiku 4.5
    // (capable enough for workflow analysis; typically has spare capacity).
    async function callWithBackoff(model: string): Promise<Anthropic.Message> {
      const MAX_ATTEMPTS = 3;
      let lastError: unknown;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          return await client.messages.create({
            model,
            max_tokens: 4096,
            system: ANALYZE_SYSTEM_PROMPT,
            messages: [{ role: "user", content: buildUserPrompt(visits) }],
          });
        } catch (err) {
          lastError = err;
          const status = err instanceof Anthropic.APIError ? err.status : undefined;
          const retryable = status === 429 || status === 529 || (status != null && status >= 500);
          if (!retryable || attempt === MAX_ATTEMPTS) throw err;
          const delay = 600 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 300);
          console.warn(`[${model}] attempt ${attempt} failed (status ${status}), retrying in ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      throw lastError;
    }

    let response: Anthropic.Message;
    try {
      response = await callWithBackoff("claude-sonnet-4-6");
    } catch (err) {
      const status = err instanceof Anthropic.APIError ? err.status : undefined;
      if (status === 529 || status === 429) {
        console.warn("Sonnet 4.6 exhausted retries; falling back to Haiku 4.5");
        response = await callWithBackoff("claude-haiku-4-5");
      } else {
        throw err;
      }
    }

    const textBlock = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === "text",
    );
    if (!textBlock) {
      return NextResponse.json(
        { error: "Claude returned no text content.", raw: response },
        { status: 502, headers: CORS_HEADERS },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripFences(textBlock.text));
    } catch (err) {
      return NextResponse.json(
        {
          error: "Claude response was not valid JSON.",
          raw_text: textBlock.text,
          parse_error: err instanceof Error ? err.message : String(err),
        },
        { status: 502, headers: CORS_HEADERS },
      );
    }

    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as { workflows?: unknown }).workflows) ||
      typeof (parsed as { summary?: unknown }).summary !== "string"
    ) {
      return NextResponse.json(
        { error: "Claude response did not match expected schema.", raw: parsed },
        { status: 502, headers: CORS_HEADERS },
      );
    }

    return NextResponse.json(parsed, { headers: CORS_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("analyze route error:", err);
    return NextResponse.json(
      { error: `Analyze failed: ${message}` },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
