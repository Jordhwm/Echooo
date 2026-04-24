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

  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const visits: Visit[] = [];
  let current: { start: number; end: number; domain: string; title: string; url: string } | null =
    null;

  const COLLAPSE_WINDOW_MS = 60_000;
  const MIN_VISIT_MS = 5_000;

  for (const e of sorted) {
    if (!e.domain) continue;
    if (
      current &&
      e.domain === current.domain &&
      e.timestamp - current.end <= COLLAPSE_WINDOW_MS
    ) {
      current.end = e.timestamp;
      current.title = e.title || current.title;
      current.url = e.url || current.url;
    } else {
      if (current) {
        const dur = current.end - current.start;
        if (dur >= MIN_VISIT_MS || visits.length === 0) {
          visits.push({
            start: current.start,
            duration_sec: Math.max(1, Math.round(dur / 1000)),
            domain: current.domain,
            title: current.title,
            url: current.url,
          });
        }
      }
      current = {
        start: e.timestamp,
        end: e.timestamp,
        domain: e.domain,
        title: e.title || "",
        url: e.url || "",
      };
    }
  }
  if (current) {
    const dur = current.end - current.start;
    visits.push({
      start: current.start,
      duration_sec: Math.max(1, Math.round(dur / 1000)),
      domain: current.domain,
      title: current.title,
      url: current.url,
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

    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: ANALYZE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(visits) }],
    });

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
