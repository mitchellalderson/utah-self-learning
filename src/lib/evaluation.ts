/**
 * Evaluation — prompt performance analysis and improvement pipeline
 *
 * Aggregates scoring data, identifies underperforming prompt versions,
 * and generates improved prompts via LLM.
 */

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
}

export interface Underperformer {
  versionId: string;
  stats: VersionStats;
  reason: string;
  gapToBest: number;
}

export type VersionStatsMap = Record<string, VersionStats>;

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

    if (!existing) {
      byVersion[entry.promptVersion] = {
        versionId: entry.promptVersion,
        count: 1,
        avgRelevance: entry.relevance,
        avgCompleteness: entry.completeness,
        avgToolEfficiency: entry.toolEfficiency,
        avgTone: entry.tone,
        avgComposite: entry.composite,
        recentRationales: [entry.rationale],
      };
    } else {
      const n = existing.count;
      existing.count = n + 1;
      existing.avgRelevance = (existing.avgRelevance * n + entry.relevance) / (n + 1);
      existing.avgCompleteness = (existing.avgCompleteness * n + entry.completeness) / (n + 1);
      existing.avgToolEfficiency =
        (existing.avgToolEfficiency * n + entry.toolEfficiency) / (n + 1);
      existing.avgTone = (existing.avgTone * n + entry.tone) / (n + 1);
      existing.avgComposite = (existing.avgComposite * n + entry.composite) / (n + 1);

      if (existing.recentRationales.length < maxRationales) {
        existing.recentRationales.push(entry.rationale);
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
      });
    }
  }

  return underperformers.sort((a, b) => b.gapToBest - a.gapToBest);
}

export async function generateImprovedPrompt(underperformer: Underperformer): Promise<string> {
  const currentSoul = await loadVersionedSoul(underperformer.versionId);

  if (!currentSoul) {
    throw new Error(`Cannot find SOUL.md for version ${underperformer.versionId}`);
  }

  const rationales = underperformer.stats.recentRationales
    .map((r, i) => `${i + 1}. ${r}`)
    .join("\n");

  const prompt = `You are improving an AI agent's behavioral prompt (SOUL.md).

## Current SOUL.md (version: ${underperformer.versionId})
${currentSoul}

## Performance Issues
This version is underperforming: ${underperformer.reason}

### Recent Score Rationales (showing issues)
${rationales}

### Average Scores
- Relevance: ${underperformer.stats.avgRelevance.toFixed(1)}/10
- Completeness: ${underperformer.stats.avgCompleteness.toFixed(1)}/10
- Tool Efficiency: ${underperformer.stats.avgToolEfficiency.toFixed(1)}/10
- Tone: ${underperformer.stats.avgTone.toFixed(1)}/10
- Composite: ${underperformer.stats.avgComposite.toFixed(1)}/10

## Your Task
Generate an improved SOUL.md that addresses these issues:

1. **Analyze** the rationales to identify patterns in what's going wrong
2. **Adjust** instructions to fix recurring problems
3. **Preserve** what's working well
4. **Keep it concise** — this is a behavioral guide, not a manual
5. **Focus on actionable guidance** — specific instructions that change behavior

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

  return response.text;
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

  const defaultStats = stats[registry.currentDefault];

  for (const version of registry.versions) {
    if (!version.active || version.id === registry.currentDefault) continue;

    const vStats = stats[version.id];
    if (!vStats || vStats.count < cfg.minDataPoints) continue;

    const hasEnoughTraffic = version.weight >= cfg.promotionTrafficThreshold;
    const scoreAdvantage = vStats.avgComposite - (defaultStats?.avgComposite ?? 0);
    const outperformsDefault = scoreAdvantage >= cfg.promotionScoreGap;

    if (hasEnoughTraffic && outperformsDefault) {
      const oldDefault = registry.currentDefault;
      registry.currentDefault = version.id;

      logger.info(
        {
          newDefault: version.id,
          oldDefault,
          scoreAdvantage: scoreAdvantage.toFixed(2),
          trafficWeight: (version.weight * 100).toFixed(1) + "%",
        },
        "[evaluation] Promoted version to currentDefault",
      );

      return version.id;
    }
  }

  return null;
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

  const content = `# Performance Summary
Last updated: ${new Date().toISOString()}
Current default: ${registry.currentDefault}

| Version | Weight | Count | Relevance | Completeness | Tool Eff | Tone | **Composite** |
|---------|--------|-------|-----------|--------------|----------|------|---------------|
${rows.join("\n")}
`;

  const filePath = resolve(config.workspace.root, "performance-summary.md");
  await writeFile(filePath, content, "utf-8");

  logger.info(
    { versions: activeVersions.length, path: filePath },
    "[evaluation] Saved performance summary",
  );
}

export function retireLowestPerformer(
  stats: VersionStatsMap,
  registry: PromptRegistry,
): string | null {
  const cfg = config.evaluation;
  const activeVersions = registry.versions.filter((v) => v.active);

  if (activeVersions.length <= cfg.maxVersions) {
    return null;
  }

  const candidates = activeVersions.filter((v) => v.id !== "v1");

  if (candidates.length === 0) {
    logger.warn("[evaluation] Cannot retire — only v1 remains");
    return null;
  }

  let lowestScore = Infinity;
  let lowestVersion: PromptVersion | null = null;

  for (const version of candidates) {
    const vStats = stats[version.id];

    if (vStats && vStats.count >= cfg.minDataPoints) {
      if (vStats.avgComposite < lowestScore) {
        lowestScore = vStats.avgComposite;
        lowestVersion = version;
      }
    }
  }

  if (!lowestVersion) {
    lowestVersion = candidates[candidates.length - 1];
  }

  lowestVersion.active = false;
  lowestVersion.weight = 0;

  const remainingActive = registry.versions.filter((v) => v.active);
  if (remainingActive.length > 0) {
    registry.versions = normalizeWeights(registry.versions);
  }

  logger.info(
    { retiredId: lowestVersion.id, lowestScore: lowestScore.toFixed(2) },
    "[evaluation] Retired lowest-performing version",
  );

  return lowestVersion.id;
}
