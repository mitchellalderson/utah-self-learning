/** Evaluation — aggregates scores, identifies underperformers, generates improved prompts. */

import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import { config } from "../config.ts";
import { logger } from "./logger.ts";
import { callLLM } from "./llm.ts";
import {
  loadRegistry,
  saveRegistry,
  loadVersionedSoul,
  normalizeWeights,
  type PromptRegistry,
  type PromptVersion,
} from "./prompt-version.ts";
import type { ScoreEntry } from "./scoring.ts";

export interface VersionStats {
  versionId: string;
  count: number;
  avgRelevance: number;
  avgCompleteness: number;
  avgToolEfficiency: number;
  avgTone: number;
  avgComposite: number;
  recentRationales: string[];
  recentImprovementHints: string[];
  issueTagCounts: Record<string, number>;
  answerTypeCounts: Record<string, number>;
}

export interface Underperformer {
  versionId: string;
  stats: VersionStats;
  reason: string;
  gapToBest: number;
  bestVersionId?: string;
}

export type VersionStatsMap = Record<string, VersionStats>;

function calculateComposite(entry: ScoreEntry): number {
  return (
    entry.relevance * 0.35 +
    entry.completeness * 0.4 +
    entry.toolEfficiency * 0.1 +
    entry.tone * 0.15
  );
}

function incrementCount(counts: Record<string, number>, key: string | undefined): void {
  if (!key) return;
  counts[key] = (counts[key] || 0) + 1;
}

function appendBounded(items: string[], values: string[], maxItems: number): void {
  for (const value of values) {
    if (!value) continue;
    items.push(value);
    if (items.length > maxItems) {
      items.shift();
    }
  }
}

function formatTopCounts(counts: Record<string, number>, limit: number = 8): string {
  const entries = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  if (entries.length === 0) {
    return "- none";
  }

  return entries.map(([key, count]) => `- ${key}: ${count}`).join("\n");
}

function formatInlineTopCounts(counts: Record<string, number>, limit: number = 4): string {
  const entries = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  if (entries.length === 0) {
    return "-";
  }

  return entries.map(([key, count]) => `${key} (${count})`).join(", ");
}

function getScoresDir(): string {
  return resolve(config.workspace.root, "scores");
}

export async function loadAllScoreLogs(): Promise<ScoreEntry[]> {
  const scoresDir = getScoresDir();
  const entries: ScoreEntry[] = [];

  if (!existsSync(scoresDir)) {
    return entries;
  }

  const files = await readdir(scoresDir);
  const jsonlFiles = files.filter((f) => f.endsWith(".jsonl")).sort();

  for (const file of jsonlFiles) {
    const content = await readFile(resolve(scoresDir, file), "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as ScoreEntry);
      } catch {
        logger.warn({ file, line: line.slice(0, 100) }, "[evaluation] Failed to parse score line");
      }
    }
  }

  return entries;
}

export function aggregateByVersion(
  scores: ScoreEntry[],
  maxRationales: number = 10,
): VersionStatsMap {
  const byVersion: VersionStatsMap = {};

  for (const entry of scores) {
    const existing = byVersion[entry.promptVersion];
    const composite = calculateComposite(entry);

    if (!existing) {
      byVersion[entry.promptVersion] = {
        versionId: entry.promptVersion,
        count: 1,
        avgRelevance: entry.relevance,
        avgCompleteness: entry.completeness,
        avgToolEfficiency: entry.toolEfficiency,
        avgTone: entry.tone,
        avgComposite: composite,
        recentRationales: [entry.rationale],
        recentImprovementHints: entry.improvementHints?.slice(0, maxRationales) ?? [],
        issueTagCounts: {},
        answerTypeCounts: {},
      };
      incrementCount(byVersion[entry.promptVersion].answerTypeCounts, entry.answerType);
      for (const tag of entry.issueTags ?? []) {
        incrementCount(byVersion[entry.promptVersion].issueTagCounts, tag);
      }
    } else {
      const n = existing.count;
      existing.count = n + 1;
      existing.avgRelevance = (existing.avgRelevance * n + entry.relevance) / (n + 1);
      existing.avgCompleteness = (existing.avgCompleteness * n + entry.completeness) / (n + 1);
      existing.avgToolEfficiency =
        (existing.avgToolEfficiency * n + entry.toolEfficiency) / (n + 1);
      existing.avgTone = (existing.avgTone * n + entry.tone) / (n + 1);
      existing.avgComposite = (existing.avgComposite * n + composite) / (n + 1);

      existing.recentRationales.push(entry.rationale);
      if (existing.recentRationales.length > maxRationales) {
        existing.recentRationales.shift();
      }
      appendBounded(existing.recentImprovementHints, entry.improvementHints ?? [], maxRationales);
      incrementCount(existing.answerTypeCounts, entry.answerType);
      for (const tag of entry.issueTags ?? []) {
        incrementCount(existing.issueTagCounts, tag);
      }
    }
  }

  return byVersion;
}

export function identifyUnderperformers(
  stats: VersionStatsMap,
  registry: PromptRegistry,
): Underperformer[] {
  const underperformers: Underperformer[] = [];
  const cfg = config.evaluation;

  const activeVersionIds = registry.versions.filter((v) => v.active).map((v) => v.id);

  const hasActiveChild = (versionId: string): boolean => {
    const version = registry.versions.find((v) => v.id === versionId);
    if (!version?.childVersion) return false;
    const child = registry.versions.find((v) => v.id === version.childVersion);
    return child?.active === true;
  };

  const hasNewScores = (versionId: string): boolean => {
    const version = registry.versions.find((v) => v.id === versionId);
    const vStats = stats[versionId];
    if (!vStats || vStats.count === 0) return false;
    if (!version?.lastEvaluatedCount) return true;
    return vStats.count > version.lastEvaluatedCount;
  };

  let bestComposite = 0;
  let bestVersionId = "";

  for (const [versionId, vStats] of Object.entries(stats)) {
    if (activeVersionIds.includes(versionId) && vStats.count >= cfg.minDataPoints) {
      if (vStats.avgComposite > bestComposite) {
        bestComposite = vStats.avgComposite;
        bestVersionId = versionId;
      }
    }
  }

  for (const [versionId, vStats] of Object.entries(stats)) {
    if (!activeVersionIds.includes(versionId)) continue;
    if (vStats.count < cfg.minDataPoints) continue;
    if (hasActiveChild(versionId)) continue;
    if (!hasNewScores(versionId)) continue;

    const gapToBest = bestComposite - vStats.avgComposite;

    const belowTarget = vStats.avgComposite < cfg.targetComposite;
    const significantlyWorse =
      bestVersionId && bestVersionId !== versionId && gapToBest >= cfg.significantGap;

    if (belowTarget || significantlyWorse) {
      const reason = belowTarget
        ? `composite ${vStats.avgComposite.toFixed(1)} < target ${cfg.targetComposite}`
        : `${gapToBest.toFixed(1)} points below best (${bestVersionId})`;

      underperformers.push({
        versionId,
        stats: vStats,
        reason,
        gapToBest,
        bestVersionId,
      });
    }
  }

  return underperformers.sort((a, b) => b.gapToBest - a.gapToBest);
}

async function loadReferenceSoul(underperformer: Underperformer): Promise<string> {
  if (!underperformer.bestVersionId || underperformer.bestVersionId === underperformer.versionId) {
    return "";
  }

  const referenceSoul = await loadVersionedSoul(underperformer.bestVersionId);
  if (!referenceSoul) return "";

  return `## Best Current SOUL.md (version: ${underperformer.bestVersionId})
Use this as a behavioral reference. Preserve patterns that likely helped it outperform the current version, but do not copy it blindly.

${referenceSoul}
`;
}

function findPromptRuleViolations(content: string): string[] {
  const checks: Array<[RegExp, string]> = [
    [/\balways\s+(include|provide|add|list|end|ask)\b/i, "Avoid absolute always-rules"],
    [
      /\bask\b.{0,80}\bbefore proceeding\b/i,
      "Do not ask for context before giving a useful default",
    ],
    [/\bavoid deep dives?\b/i, "Do not discourage depth by default"],
    [/\bpros\s*\/\s*cons table\b/i, "Do not require pros/cons tables"],
    [/\bat least\s+\w+\s+(items|failure|scenarios|pros|cons)\b/i, "Do not require fixed counts"],
    [
      /\b(sentences?|explanations?)\s*(?:<=|<|under|less than)\s*\d+/i,
      "Do not impose strict length caps",
    ],
    [/\bNext step[.:]/i, "Do not require a canned ending phrase"],
    [/[“"](?:bash|yaml|terraform|kubectl)[”"]\s+tool/i, "Do not mention imaginary tools"],
    [/\bTool Usage Checklist\b/i, "Do not include a fake tool checklist"],
    [/\bFollow this pattern for every\b/i, "Do not force one pattern for every answer"],
  ];

  return checks.filter(([pattern]) => pattern.test(content)).map(([, message]) => message);
}

async function repairGeneratedPrompt(content: string, violations: string[]): Promise<string> {
  const response = await callLLM(
    "You repair AI behavioral prompts. Output only the corrected SOUL.md content.",
    [
      {
        role: "user" as const,
        timestamp: Date.now(),
        content: `Repair this SOUL.md so it keeps the useful guidance but removes the listed rule violations.

## Violations
${violations.map((v, i) => `${i + 1}. ${v}`).join("\n")}

## SOUL.md
${content}

Return ONLY the repaired SOUL.md. Start with "# Soul".`,
      },
    ],
    [],
  );

  return response.text;
}

export async function generateImprovedPrompt(underperformer: Underperformer): Promise<string> {
  const currentSoul = await loadVersionedSoul(underperformer.versionId);

  if (!currentSoul) {
    throw new Error(`Cannot find SOUL.md for version ${underperformer.versionId}`);
  }

  const rationales = underperformer.stats.recentRationales
    .map((r, i) => `${i + 1}. ${r}`)
    .join("\n");
  const improvementHints =
    underperformer.stats.recentImprovementHints.length > 0
      ? underperformer.stats.recentImprovementHints.map((h, i) => `${i + 1}. ${h}`).join("\n")
      : "No structured hints are available yet. Infer cautiously from the rationales.";
  const issuePatternSummary = formatTopCounts(underperformer.stats.issueTagCounts);
  const answerTypeSummary = formatTopCounts(underperformer.stats.answerTypeCounts);
  const referenceSoul = await loadReferenceSoul(underperformer);

  const prompt = `You are improving an AI agent's behavioral prompt (SOUL.md).

## Current SOUL.md (version: ${underperformer.versionId})
${currentSoul}

${referenceSoul}

## Performance Issues
This version is underperforming: ${underperformer.reason}

### Recent Score Rationales (showing issues)
${rationales}

### Structured Issue Tags
${issuePatternSummary}

### Answer Type Mix
${answerTypeSummary}

### Recent Improvement Hints
${improvementHints}

### Average Scores
- Relevance: ${underperformer.stats.avgRelevance.toFixed(1)}/10
- Completeness: ${underperformer.stats.avgCompleteness.toFixed(1)}/10
- Tool Efficiency: ${underperformer.stats.avgToolEfficiency.toFixed(1)}/10
- Tone: ${underperformer.stats.avgTone.toFixed(1)}/10
- Composite: ${underperformer.stats.avgComposite.toFixed(1)}/10

## Your Task
Generate an improved SOUL.md that addresses these issues:

1. **Analyze** the rationales to identify patterns in what's going wrong.
2. **Recover what works** from the best current prompt when one is provided.
3. **Adjust** instructions to fix recurring problems.
4. **Preserve** what's working well.
5. **Keep it concise** — this is a behavioral guide, not a manual.
6. **Focus on actionable guidance** — specific instructions that change behavior.

## REQUIRED IMPROVEMENT DIRECTION
The score history shows that shallow answers, missing production details, and clarification-only replies hurt performance. It also shows that overly rigid templates regress.

Your improved SOUL.md must guide the agent to:
- Start with the most likely answer, diagnosis, or recommendation.
- Adapt to the request type instead of forcing one answer skeleton:
  - Debugging: rank likely causes, then give verification commands or checks.
  - Design: describe architecture, tradeoffs, constraints, failure modes, and operations.
  - Comparison: compare against the user's stated scale and requirements, then recommend.
  - Implementation: provide concrete commands, config, code, manifests, policies, queries, or workflow YAML when useful.
- If context is missing, state a reasonable assumption and continue. Ask a clarifying question only when a safe answer is impossible.
- Include deploy/verify/monitor/fail/rollback guidance for production changes.
- Prioritize scenario-specific details over generic checklists.
- Be concise without becoming shallow.
- Keep domain facts correct; avoid invalid fields, fake APIs, placeholder policies, or commands that commonly fail.

## PATTERNS TO AVOID
Do NOT add instructions that:
- Always require a snippet, table, migration plan, fixed number of failure modes, or fixed ending phrase.
- Tell the agent to avoid deep dives by default; many hard technical questions require depth.
- Tell the agent to ask for missing context before giving any useful answer.
- Mention imaginary tools such as "bash tool", "yaml tool", or "terraform tool".
- Overfit to one domain such as Kubernetes when the questions span DevOps, IaC, networking, observability, cloud architecture, cost, and security.
- Impose strict word limits or sentence-length limits that make answers incomplete.
- Add canned examples that are likely to leak into unrelated answers.

## RECOMMENDED PROMPT SHAPE
Use a compact structure similar to:

# Soul

Be helpful, concise, and direct. Answer with practitioner-grade detail.
Use tools only when they add value.

## Core Behavior
- Start with the most likely answer, diagnosis, or recommendation.
- Adapt to debugging, design, comparison, and implementation requests.
- State reasonable assumptions and proceed when context is missing.
- Use tables only when they make comparison clearer.

## Depth Standard
- Anchor the answer in the user's exact scenario.
- Include concrete commands, config, code, policies, queries, or manifests when useful.
- Cover verification, failure modes, edge cases, and rollback for production changes.
- Explain tradeoffs plainly.
- Avoid generic checklists and invalid technical details.

## Domain Cues
- Include short cues for Kubernetes, GitOps/CI, Terraform/IaC, networking, observability, cloud architecture, cost, and security.

## Tone
- Be crisp, confident when warranted, and free of filler.
- End with validation or the next practical action.

## CRITICAL OUTPUT RULES
- Output ONLY the improved SOUL.md content
- NO explanations, commentary, or meta-text
- NO scoring targets (e.g., "Target Composite Score: 8+")
- NO performance metrics or evaluation data
- NO "Performance Issues", "Average Scores", or "Your Task" sections
- The output must be pure behavioral guidance that the agent will use at runtime
- Start with "# Soul" as the header

The agent using this SOUL.md should NOT know about scoring criteria or evaluation metrics.`;

  const response = await callLLM(
    "You are a prompt engineering assistant. Output only the improved SOUL.md content.",
    [{ role: "user" as const, content: prompt, timestamp: Date.now() }],
    [],
  );

  const violations = findPromptRuleViolations(response.text);
  if (violations.length === 0) {
    return response.text;
  }

  logger.warn(
    { versionId: underperformer.versionId, violations },
    "[evaluation] Generated prompt hit forbidden patterns; repairing",
  );

  const repaired = await repairGeneratedPrompt(response.text, violations);
  const remainingViolations = findPromptRuleViolations(repaired);

  if (remainingViolations.length > 0) {
    logger.warn(
      { versionId: underperformer.versionId, remainingViolations },
      "[evaluation] Repaired prompt still contains forbidden patterns",
    );
  }

  return repaired;
}

export function getNextVersionId(registry: PromptRegistry): string {
  let maxNum = 0;

  for (const version of registry.versions) {
    const match = version.id.match(/^v(\d+)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  }

  return `v${maxNum + 1}`;
}

export async function createNewVersion(
  parentId: string,
  content: string,
  registry: PromptRegistry,
  parentScoreCount: number,
): Promise<string> {
  const newVersionId = getNextVersionId(registry);
  const promptsDir = resolve(config.workspace.root, "prompts");
  const newVersionDir = resolve(promptsDir, newVersionId);

  if (!existsSync(newVersionDir)) {
    await mkdir(newVersionDir, { recursive: true });
  }

  await writeFile(resolve(newVersionDir, "SOUL.md"), content, "utf-8");

  const cfg = config.evaluation;
  const newWeight = cfg.newVersionWeight;
  const remainingWeight = 1.0 - newWeight;

  const otherActiveVersions = registry.versions.filter((v) => v.active && v.id !== newVersionId);

  const otherTotalWeight = otherActiveVersions.reduce((sum, v) => sum + v.weight, 0);

  for (const version of registry.versions) {
    if (version.active && version.id !== newVersionId) {
      version.weight = (version.weight / otherTotalWeight) * remainingWeight;
    }
  }

  const newVersion: PromptVersion = {
    id: newVersionId,
    created: new Date().toISOString(),
    source: "evaluation-pipeline",
    active: true,
    weight: newWeight,
    parentVersion: parentId,
  };

  registry.versions.push(newVersion);

  const parent = registry.versions.find((v) => v.id === parentId);
  if (parent) {
    parent.childVersion = newVersionId;
    parent.lastEvaluatedCount = parentScoreCount;
  }

  registry.versions = normalizeWeights(registry.versions);

  await saveRegistry(registry);

  logger.info(
    { newVersionId, parentId, weight: newWeight },
    "[evaluation] Created new prompt version",
  );

  return newVersionId;
}

export function promoteWinners(stats: VersionStatsMap, registry: PromptRegistry): string | null {
  const cfg = config.evaluation;
  const currentDefault = registry.versions.find((v) => v.id === registry.currentDefault);

  if (!currentDefault) {
    logger.warn("[evaluation] No current default found in registry");
    return null;
  }

  let bestVersion: PromptVersion | null = null;
  let bestComposite = 0;

  for (const version of registry.versions) {
    if (!version.active) continue;
    const vStats = stats[version.id];
    if (!vStats || vStats.count < cfg.minDataPoints) continue;

    if (vStats.avgComposite > bestComposite) {
      bestComposite = vStats.avgComposite;
      bestVersion = version;
    }
  }

  if (!bestVersion) return null;

  const defaultStats = stats[registry.currentDefault];
  const defaultComposite = defaultStats?.avgComposite ?? 0;
  const scoreAdvantage = bestComposite - defaultComposite;

  if (bestVersion.id !== registry.currentDefault && scoreAdvantage >= cfg.promotionScoreGap) {
    const oldDefault = registry.currentDefault;
    registry.currentDefault = bestVersion.id;

    logger.info(
      {
        newDefault: bestVersion.id,
        oldDefault,
        scoreAdvantage: scoreAdvantage.toFixed(2),
      },
      "[evaluation] Promoted version to currentDefault",
    );
  }

  const targetBestWeight = cfg.promotionTrafficThreshold;
  const activeVersions = registry.versions.filter((v) => v.active);

  if (activeVersions.length > 1 && bestVersion.weight < targetBestWeight) {
    const remainingWeight = 1.0 - targetBestWeight;
    const otherActive = activeVersions.filter((v) => v.id !== bestVersion!.id);
    const otherTotalWeight = otherActive.reduce((sum, v) => sum + v.weight, 0);

    bestVersion.weight = targetBestWeight;
    for (const version of otherActive) {
      version.weight =
        otherTotalWeight > 0
          ? (version.weight / otherTotalWeight) * remainingWeight
          : remainingWeight / otherActive.length;
    }

    registry.versions = normalizeWeights(registry.versions);

    logger.info(
      {
        bestVersion: bestVersion.id,
        bestWeight: (bestVersion.weight * 100).toFixed(1) + "%",
        bestComposite: bestComposite.toFixed(2),
      },
      "[evaluation] Redistributed weight toward best performer",
    );
  }

  return bestVersion.id !== registry.currentDefault ? null : bestVersion.id;
}

export async function savePerformanceSummary(
  stats: VersionStatsMap,
  registry: PromptRegistry,
): Promise<void> {
  const activeVersions = registry.versions
    .filter((v) => v.active)
    .map((v) => ({
      id: v.id,
      weight: v.weight,
      stats: stats[v.id],
    }))
    .filter((v) => v.stats)
    .sort((a, b) => b.stats.avgComposite - a.stats.avgComposite);

  const isDefault = (id: string) => id === registry.currentDefault;
  const weightPct = (w: number) => (w * 100).toFixed(0) + "%";
  const score = (n: number) => n.toFixed(1);

  const rows = activeVersions.map(
    (v) =>
      `| ${v.id}${isDefault(v.id) ? " ⭐" : ""} | ${weightPct(v.weight)} | ${v.stats.count} | ${score(v.stats.avgRelevance)} | ${score(v.stats.avgCompleteness)} | ${score(v.stats.avgToolEfficiency)} | ${score(v.stats.avgTone)} | **${score(v.stats.avgComposite)}** |`,
  );
  const issueRows = activeVersions.map(
    (v) =>
      `| ${v.id}${isDefault(v.id) ? " ⭐" : ""} | ${formatInlineTopCounts(v.stats.issueTagCounts)} | ${formatInlineTopCounts(v.stats.answerTypeCounts)} |`,
  );

  const content = `# Performance Summary
Last updated: ${new Date().toISOString()}
Current default: ${registry.currentDefault}

| Version | Weight | Count | Relevance | Completeness | Tool Eff | Tone | **Composite** |
|---------|--------|-------|-----------|--------------|----------|------|---------------|
${rows.join("\n")}

## Failure Patterns

| Version | Top Issue Tags | Answer Types |
|---------|----------------|--------------|
${issueRows.join("\n")}
`;

  const filePath = resolve(config.workspace.root, "performance-summary.md");
  await writeFile(filePath, content, "utf-8");

  logger.info(
    { versions: activeVersions.length, path: filePath },
    "[evaluation] Saved performance summary",
  );
}

const MIN_WEIGHT_THRESHOLD = 0.02;

export function enforceVersionCap(stats: VersionStatsMap, registry: PromptRegistry): string[] {
  const cfg = config.evaluation;
  const retired: string[] = [];
  const activeWithStats = registry.versions
    .filter((v) => v.active)
    .map((v) => ({ version: v, stats: stats[v.id] }))
    .filter((v) => v.stats && v.stats.count >= cfg.minDataPoints);
  const bestComposite = activeWithStats.reduce(
    (best, v) => Math.max(best, v.stats.avgComposite),
    0,
  );

  for (const version of registry.versions) {
    if (!version.active) continue;
    if (version.id === registry.currentDefault) continue;
    if (version.weight < MIN_WEIGHT_THRESHOLD) {
      version.active = false;
      version.weight = 0;
      retired.push(version.id);
      logger.info(
        { retiredId: version.id, weight: version.weight },
        "[evaluation] Culled version below minimum weight threshold",
      );
      continue;
    }

    const vStats = stats[version.id];
    const hasEnoughData = vStats && vStats.count >= cfg.minDataPoints;
    const gapToBest = hasEnoughData ? bestComposite - vStats.avgComposite : 0;

    if (hasEnoughData && gapToBest >= cfg.retireScoreGap) {
      version.active = false;
      version.weight = 0;
      retired.push(version.id);
      logger.info(
        {
          retiredId: version.id,
          composite: vStats.avgComposite.toFixed(2),
          gapToBest: gapToBest.toFixed(2),
        },
        "[evaluation] Retired version below best performer",
      );
    }
  }

  let activeVersions = registry.versions.filter((v) => v.active);

  while (activeVersions.length > cfg.maxVersions) {
    const candidates = activeVersions.filter((v) => v.id !== registry.currentDefault);

    if (candidates.length === 0) {
      logger.warn("[evaluation] Cannot retire — only current default remains");
      break;
    }

    const scored = candidates
      .filter((v) => stats[v.id] && stats[v.id].count >= cfg.minDataPoints)
      .sort((a, b) => (stats[a.id]?.avgComposite ?? 0) - (stats[b.id]?.avgComposite ?? 0));

    const victim = scored.length > 0 ? scored[0] : candidates[candidates.length - 1];

    victim.active = false;
    victim.weight = 0;
    retired.push(victim.id);

    logger.info(
      {
        retiredId: victim.id,
        composite: stats[victim.id]?.avgComposite?.toFixed(2) ?? "n/a",
        activeRemaining: activeVersions.length - 1,
      },
      "[evaluation] Retired lowest-performing version",
    );

    activeVersions = registry.versions.filter((v) => v.active);
  }

  if (retired.length > 0) {
    registry.versions = normalizeWeights(registry.versions);
  }

  return retired;
}
