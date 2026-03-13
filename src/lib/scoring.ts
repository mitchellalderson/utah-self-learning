/**
 * Scoring — response quality evaluation system
 *
 * After each agent response, a lighter LLM scores the response
 * on defined dimensions. Scores are persisted to JSONL files.
 */

import { appendFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import { getModel, complete } from "@mariozechner/pi-ai";
import type { KnownProvider } from "@mariozechner/pi-ai";
import { config } from "../config.ts";

export interface ScoreEntry {
  timestamp: string;
  sessionKey: string;
  promptVersion: string;
  relevance: number;
  completeness: number;
  toolEfficiency: number;
  tone: number;
  composite: number;
  rationale: string;
}

export interface ScoreInput {
  userMessage: string;
  agentResponse: string;
  toolCallCount: number;
  sessionKey: string;
  promptVersion: string;
}

function getScoresPath(): string {
  const date = new Date().toISOString().split("T")[0];
  return resolve(config.workspace.root, "scores", `${date}.jsonl`);
}

async function ensureScoresDir(): Promise<void> {
  const dir = resolve(config.workspace.root, "scores");
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

const SCORING_PROMPT = `You are a response quality evaluator. Score this agent response on 4 dimensions (0-10 each).

Scoring criteria:
1. Relevance (0-10): Did the response directly address the user's actual question or request?
2. Completeness (0-10): Was anything important missing from the response?
3. Tool efficiency (0-10): Were tool calls necessary and well-targeted? (N/A if 0 tool calls)
4. Tone alignment (0-10): Did the response match guidelines to be "helpful, concise, direct"?

User message:
{USER_MESSAGE}

Agent response:
{AGENT_RESPONSE}

Tool calls made: {TOOL_CALL_COUNT}

Respond with ONLY valid JSON, no markdown:
{"relevance": N, "completeness": N, "toolEfficiency": N, "tone": N, "rationale": "1-2 sentence explanation"}`;

export async function scoreResponse(input: ScoreInput): Promise<ScoreEntry> {
  const model = getModel(
    config.scoring.provider as KnownProvider as any,
    config.scoring.model as any,
  );

  if (!model) {
    throw new Error(
      `Unknown scoring model "${config.scoring.model}" for provider "${config.scoring.provider}"`,
    );
  }

  const prompt = SCORING_PROMPT.replace("{USER_MESSAGE}", input.userMessage.slice(0, 2000))
    .replace("{AGENT_RESPONSE}", input.agentResponse.slice(0, 2000))
    .replace("{TOOL_CALL_COUNT}", String(input.toolCallCount));

  const result = await complete(model, {
    systemPrompt: "You are a JSON-only response evaluator. Output only valid JSON.",
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
  });

  const text = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();

  let scores: {
    relevance: number;
    completeness: number;
    toolEfficiency: number;
    tone: number;
    rationale: string;
  };

  try {
    const parsed = JSON.parse(text);
    scores = {
      relevance: Math.max(0, Math.min(10, Number(parsed.relevance) || 0)),
      completeness: Math.max(0, Math.min(10, Number(parsed.completeness) || 0)),
      toolEfficiency: Math.max(0, Math.min(10, Number(parsed.toolEfficiency) || 0)),
      tone: Math.max(0, Math.min(10, Number(parsed.tone) || 0)),
      rationale: String(parsed.rationale || "").slice(0, 500),
    };
  } catch {
    scores = {
      relevance: 5,
      completeness: 5,
      toolEfficiency: 5,
      tone: 5,
      rationale: "Failed to parse LLM scoring response",
    };
  }

  const composite =
    (scores.relevance + scores.completeness + scores.toolEfficiency + scores.tone) / 4;

  const entry: ScoreEntry = {
    timestamp: new Date().toISOString(),
    sessionKey: input.sessionKey,
    promptVersion: input.promptVersion,
    relevance: scores.relevance,
    completeness: scores.completeness,
    toolEfficiency: scores.toolEfficiency,
    tone: scores.tone,
    composite: Math.round(composite * 10) / 10,
    rationale: scores.rationale,
  };

  return entry;
}

export async function appendScoreLog(entry: ScoreEntry): Promise<void> {
  await ensureScoresDir();
  const path = getScoresPath();
  await appendFile(path, JSON.stringify(entry) + "\n", "utf-8");
}
