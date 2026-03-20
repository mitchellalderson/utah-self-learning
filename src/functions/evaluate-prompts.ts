/** Evaluate Prompts — cron that aggregates scores, promotes winners, rewrites underperformers. */

import { inngest } from "../client.ts";
import { config } from "../config.ts";
import { logger } from "../lib/logger.ts";
import {
  loadAllScoreLogs,
  aggregateByVersion,
  identifyUnderperformers,
  generateImprovedPrompt,
  createNewVersion,
  promoteWinners,
  enforceVersionCap,
  savePerformanceSummary,
} from "../lib/evaluation.ts";
import { loadRegistry, saveRegistry } from "../lib/prompt-version.ts";

const EVALUATION_CRON = config.evaluation.cron;

export const evaluatePrompts = inngest.createFunction(
  {
    id: "evaluate-prompts",
    name: "Prompt Evaluation Pipeline",
    triggers: [{ cron: EVALUATION_CRON }],
  },
  async ({ step }) => {
    // Step 1: Load all scoring data
    const scores = await step.run("load-scores", async () => {
      const allScores = await loadAllScoreLogs();
      logger.info({ count: allScores.length }, "[evaluate-prompts] Loaded scores");
      return allScores;
    });

    // Step 2: Aggregate by version
    const stats = await step.run("aggregate-stats", async () => {
      const aggregated = aggregateByVersion(scores);
      const summary = Object.fromEntries(
        Object.entries(aggregated).map(([id, s]) => [
          id,
          { count: s.count, composite: s.avgComposite.toFixed(2) },
        ]),
      );
      logger.info({ versions: summary }, "[evaluate-prompts] Aggregated stats");
      return aggregated;
    });

    // Step 3: Load registry
    const registry = await step.run("load-registry", async () => {
      return await loadRegistry();
    });

    // Step 4: Promote winners (before retirement so best performer is protected)
    const promotionResult = await step.run("promote-winners", async () => {
      const promotedId = promoteWinners(stats, registry);
      return promotedId;
    });

    // Step 5: Enforce version cap BEFORE creating new versions
    // This culls low-weight zombies and retires worst performers down to maxVersions
    const retirementResult = await step.run("enforce-cap", async () => {
      const retiredIds = enforceVersionCap(stats, registry);
      return retiredIds;
    });

    // Step 6: Identify and fix underperformers (only after cap is enforced)
    const rewriteResults = await step.run("check-rewrites", async () => {
      const underperformers = identifyUnderperformers(stats, registry);
      const results: Array<{ parentId: string; newVersionId: string; reason: string }> = [];

      // Only create new versions if we have room (or will replace 1:1)
      const activeCount = registry.versions.filter((v) => v.active).length;
      const maxNewVersions = Math.max(0, config.evaluation.maxVersions - activeCount);

      for (const underperformer of underperformers.slice(0, maxNewVersions)) {
        try {
          logger.info(
            {
              versionId: underperformer.versionId,
              reason: underperformer.reason,
              composite: underperformer.stats.avgComposite.toFixed(2),
            },
            "[evaluate-prompts] Generating improved prompt",
          );

          const improvedContent = await generateImprovedPrompt(underperformer);
          const newVersionId = await createNewVersion(
            underperformer.versionId,
            improvedContent,
            registry,
            underperformer.stats.count,
          );

          results.push({
            parentId: underperformer.versionId,
            newVersionId,
            reason: underperformer.reason,
          });
        } catch (err) {
          logger.error(
            { err, versionId: underperformer.versionId },
            "[evaluate-prompts] Failed to generate improved prompt",
          );
        }
      }

      return results;
    });

    // Step 7: Save performance summary and registry
    await step.run("save-summary", async () => {
      await savePerformanceSummary(stats, registry);
    });

    await step.run("save-registry", async () => {
      await saveRegistry(registry);
    });

    return {
      status: "completed",
      scoresAnalyzed: scores.length,
      versionsWithStats: Object.keys(stats).length,
      rewritesTriggered: rewriteResults.length,
      rewrites: rewriteResults,
      promotedToDefault: promotionResult,
      retiredVersions: retirementResult,
    };
  },
);
