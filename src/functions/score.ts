/** Score Handler — async scoring after reply. Calls scoring LLM, appends to JSONL log. */

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

    const { entry, rawLlmResponse } = await step.run("score", async () => {
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
        rawLlmResponse: rawLlmResponse.slice(0, 1000),
        dimensions: {
          relevance: entry.relevance,
          completeness: entry.completeness,
          toolEfficiency: entry.toolEfficiency,
          tone: entry.tone,
        },
      },
      `[scoring] session=${sessionKey} composite=${entry.composite}`,
    );

    return { ...entry, rawLlmResponse: rawLlmResponse.slice(0, 2000) };
  },
);
