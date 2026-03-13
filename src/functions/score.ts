/**
 * Score Handler — async response quality evaluation.
 *
 * Trigger: agent.score.request
 * Flow: receive scoring request → call scoring LLM → append to JSONL log
 *
 * Runs independently after the reply has been sent.
 * Failures here don't affect reply delivery.
 */

import { inngest, agentScoreRequest } from "../client.ts";
import { scoreResponse, appendScoreLog } from "../lib/scoring.ts";

export const handleScore = inngest.createFunction(
  {
    id: "agent-handle-score",
    retries: 1,
    triggers: [agentScoreRequest],
  },
  async ({ event, step, logger }) => {
    const { userMessage, agentResponse, toolCallCount, sessionKey, promptVersion } = event.data;

    const entry = await step.run("score", async () => {
      return await scoreResponse({
        userMessage,
        agentResponse,
        toolCallCount,
        sessionKey,
        promptVersion,
      });
    });

    await step.run("save-score", async () => {
      await appendScoreLog(entry);
    });

    logger.info(
      {
        sessionKey,
        composite: entry.composite,
        dimensions: {
          relevance: entry.relevance,
          completeness: entry.completeness,
          toolEfficiency: entry.toolEfficiency,
          tone: entry.tone,
        },
      },
      `[scoring] session=${sessionKey} composite=${entry.composite}`,
    );

    return entry;
  },
);
