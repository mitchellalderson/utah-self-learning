/** Scoring — a lighter LLM scores each response on defined dimensions, persisted to JSONL. */

import { appendFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import { getModel, complete } from "@mariozechner/pi-ai";
import type { KnownProvider, Model } from "@mariozechner/pi-ai";
import { config } from "../config.ts";
import { logger } from "./logger.ts";

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

export interface ScoreResult {
  entry: ScoreEntry;
  rawLlmResponse: string;
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

const SCORING_PROMPT = `You are a harsh, expert-level response quality evaluator. Your job is to find flaws, not give praise. A score of 7+ should be rare and reserved for genuinely excellent responses. Most responses should score 3-6.

Score this agent response on 4 dimensions (0-10 each). Be brutally honest.

Scoring criteria:

1. Relevance (0-10): Did the response answer the SPECIFIC question asked, or did it give generic/textbook information?
   - 0-2: Completely off-topic or misunderstood the question
   - 3-4: Partially relevant but missed the core ask
   - 5-6: Addressed the topic but lacked specificity to the actual scenario described
   - 7-8: Directly answered the specific question with actionable detail
   - 9-10: Precisely targeted the exact scenario, anticipated follow-ups

2. Completeness (0-10): For technical questions, did the response provide SPECIFIC commands, configs, file paths, and exact steps — or just high-level hand-waving?
   - 0-2: Barely scratched the surface
   - 3-4: Covered basics but missing critical details a practitioner would need
   - 5-6: Reasonable coverage but gaps in important areas (e.g. rollback strategy, edge cases, failure modes)
   - 7-8: Thorough with specific, implementable details
   - 9-10: Production-ready depth including edge cases, failure modes, and tradeoffs

3. Tool efficiency (0-10): Were tool calls necessary and well-targeted? Score 5 if 0 tool calls and no tools were needed.
   - Penalize heavily for unnecessary tool calls or failing to use tools when they would have helped

4. Tone alignment (0-10): Was the response concise and direct, or bloated with filler?
   - 0-2: Rambling, unfocused, or inappropriate tone
   - 3-4: Too verbose, excessive caveats, or unnecessary preamble
   - 5-6: Acceptable but could be tighter
   - 7-8: Concise and well-structured
   - 9-10: Perfectly calibrated — dense with information, zero waste

COMMON DEDUCTIONS (apply these aggressively):
- Generic advice that could come from a Google search: -3 to completeness
- Bullet lists without specific commands/configs when the question demands them: -2 to completeness
- "It depends" without then actually evaluating the tradeoffs for the stated scenario: -3 to relevance
- Markdown tables used as padding rather than adding clarity: -2 to tone
- Response is truncated or cuts off mid-thought: -4 to completeness
- No mention of failure modes, rollback, or what can go wrong: -2 to completeness

User message:
{USER_MESSAGE}

Agent response:
{AGENT_RESPONSE}

Tool calls made: {TOOL_CALL_COUNT}

Respond with ONLY valid JSON, no markdown code fences:
{"relevance": N, "completeness": N, "toolEfficiency": N, "tone": N, "rationale": "1-2 sentence explanation of biggest weaknesses"}`;

export async function scoreResponse(input: ScoreInput): Promise<ScoreResult> {
  let model: ReturnType<typeof getModel> | Model<"openai-completions">;

  if (config.llm.openaiBaseUrl) {
    // When using a custom OpenAI-compatible endpoint, use the agent model
    // unless SCORING_MODEL was explicitly set to something different from the default
    const scoringModelId = process.env.SCORING_MODEL || config.llm.model;
    model = {
      id: scoringModelId,
      name: scoringModelId,
      api: "openai-completions",
      provider: config.scoring.provider || "openai",
      baseUrl: config.llm.openaiBaseUrl,
      reasoning: false,
      input: ["text"] as const,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 32_000,
    } satisfies Model<"openai-completions">;
    logger.info(
      { scoringModelId, baseUrl: config.llm.openaiBaseUrl },
      "[scoring] Using custom endpoint",
    );
  } else {
    model = getModel(config.scoring.provider as KnownProvider as any, config.scoring.model as any);

    if (!model) {
      throw new Error(
        `Unknown scoring model "${config.scoring.model}" for provider "${config.scoring.provider}"`,
      );
    }
  }

  const prompt = SCORING_PROMPT.replace("{USER_MESSAGE}", input.userMessage.slice(0, 4000))
    .replace("{AGENT_RESPONSE}", input.agentResponse.slice(0, 8000))
    .replace("{TOOL_CALL_COUNT}", String(input.toolCallCount));

  const result = await complete(model, {
    systemPrompt:
      "You are a strict, critical JSON-only response evaluator. You are hard to impress. Most responses deserve a 4-6, not a 7+. Output only valid JSON, no markdown.",
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
  });

  logger.info(
    {
      stopReason: result.stopReason,
      provider: result.provider,
      model: result.model,
      api: result.api,
      errorMessage: (result as any).errorMessage || null,
      usage: result.usage,
      contentLength: result.content.length,
      contentTypes: result.content.map((c) => c.type),
      rawContent: JSON.stringify(result.content).slice(0, 2000),
    },
    "[scoring] Full LLM result metadata",
  );

  // Prefer "text" blocks; fall back to "thinking" blocks for reasoning models
  const textBlocks = result.content.filter((c: any) => c.type === "text" && c.text);
  const thinkingBlocks = result.content.filter((c: any) => c.type === "thinking" && c.thinking);

  const allText =
    textBlocks.length > 0
      ? textBlocks
          .map((c: any) => c.text)
          .join("")
          .trim()
      : thinkingBlocks
          .map((c: any) => c.thinking)
          .join("")
          .trim();

  const rawText = allText;
  const text = rawText
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/, "")
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
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err), rawText: rawText.slice(0, 1000) },
      "[scoring] Failed to parse LLM scoring response",
    );
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

  return { entry, rawLlmResponse: rawText };
}

export async function appendScoreLog(entry: ScoreEntry): Promise<void> {
  await ensureScoresDir();
  const path = getScoresPath();
  await appendFile(path, JSON.stringify(entry) + "\n", "utf-8");
}
