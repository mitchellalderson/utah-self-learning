/**
 * Agent Loop — the core think → act → observe cycle.
 * Every LLM call and tool execution is an Inngest step for durability.
 */

import { config } from "./config.ts";
import { callLLM, validateToolArguments, type Message, type TextContent } from "./lib/llm.ts";
import type { ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import { TOOLS, executeTool, type ToolResult } from "./lib/tools.ts";
import { buildSystemPrompt, buildConversationHistory } from "./lib/context.ts";
import { ensureWorkspace } from "./lib/memory.ts";
import { shouldCompact, runCompaction } from "./lib/compaction.ts";
import type { SessionMessage } from "./lib/session.ts";
import type { GetStepTools } from "inngest";
import type { Logger } from "inngest";
import type { inngest } from "./client.ts";
import type { Destination } from "./channels/types.ts";

export interface AgentRunResult {
  response: string;
  iterations: number;
  toolCalls: number;
  model: string;
  incrementalRepliesSent: number;
  promptVersion: string;
}

// Two-tier pruning: soft trim (head+tail) or hard clear when context is huge
const PRUNING = {
  keepLastAssistantTurns: 3,
  softTrim: {
    maxChars: 4000,
    headChars: 1500,
    tailChars: 1500,
  },
  hardClear: {
    threshold: 50_000,
    placeholder: "[Tool result cleared — old context]",
  },
} as const;

function pruneOldToolResults(messages: Message[]) {
  const recentCount = PRUNING.keepLastAssistantTurns * 2;
  const pruneUpTo = Math.max(0, messages.length - recentCount);

  let totalToolChars = 0;
  for (let i = 0; i < pruneUpTo; i++) {
    const msg = messages[i];
    if (msg.role !== "toolResult") continue;
    const trMsg = msg as ToolResultMessage;
    for (const block of trMsg.content) {
      if (block.type === "text") {
        totalToolChars += block.text.length;
      }
    }
  }

  const useHardClear = totalToolChars > PRUNING.hardClear.threshold;

  for (let i = 0; i < pruneUpTo; i++) {
    const msg = messages[i];
    if (msg.role !== "toolResult") continue;
    const trMsg = msg as ToolResultMessage;
    for (const block of trMsg.content) {
      if (block.type === "text") {
        if (useHardClear) {
          (block as TextContent).text = PRUNING.hardClear.placeholder;
        } else if (block.text.length > PRUNING.softTrim.maxChars) {
          const head = block.text.slice(0, PRUNING.softTrim.headChars);
          const tail = block.text.slice(-PRUNING.softTrim.tailChars);
          (block as TextContent).text =
            `${head}\n\n... [${block.text.length - PRUNING.softTrim.headChars - PRUNING.softTrim.tailChars} chars trimmed] ...\n\n${tail}`;
        }
      }
    }
  }
}

type StepAPI = GetStepTools<typeof inngest>;
type ToolStepInput = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export interface AgentLoopOptions {
  tools?: typeof TOOLS;
  isSubAgent?: boolean;
  channelRouting?: {
    channel: string;
    destination: {
      chatId: string;
      messageId?: string;
      threadId?: string;
    };
    channelMeta: Record<string, unknown>;
  };
}

export function createAgentLoop(
  userMessage: string,
  sessionKey: string,
  options?: AgentLoopOptions,
) {
  return async (step: StepAPI, logger: Logger): Promise<AgentRunResult> => {
    const tools = options?.tools ?? TOOLS;
    const loopChannel = options?.channelRouting;

    await step.run("ensure-workspace", async () => {
      await ensureWorkspace();
    });

    const { prompt: systemPrompt, promptVersion } = await step.run("load-context", async () => {
      return await buildSystemPrompt();
    });

    let history: SessionMessage[] = await step.run("load-history", async () => {
      return await buildConversationHistory(sessionKey);
    });

    if (shouldCompact(history)) {
      history = await step.run("compact", async () => {
        return await runCompaction(history, sessionKey, logger);
      });
    }

    // Build message array in pi-ai format
    const messages: Message[] = [
      ...history.map((h): Message => {
        if (h.role === "assistant") {
          return {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: h.content }],
            api: "" as any,
            provider: "",
            model: "",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "stop" as const,
            timestamp: Date.now(),
          };
        }
        return {
          role: "user" as const,
          content: h.content,
          timestamp: Date.now(),
        };
      }),
      { role: "user" as const, content: userMessage, timestamp: Date.now() },
    ];

    let iterations = 0;
    let totalToolCalls = 0;
    let finalResponse = "";
    const textParts: string[] = [];
    let done = false;
    let hasCompactedThisRun = false;
    const emittedTextParts: string[] = [];

    while (!done && iterations < config.loop.maxIterations) {
      iterations++;

      if (iterations > PRUNING.keepLastAssistantTurns) {
        pruneOldToolResults(messages);
      }

      const budgetWarning =
        iterations >= config.loop.maxIterations - 3
          ? `\n\n[SYSTEM: You are on iteration ${iterations} of ${config.loop.maxIterations}. You MUST respond with your final answer NOW. Do not call any more tools.]`
          : iterations >= config.loop.maxIterations - 10
            ? `\n\n[SYSTEM: Iteration ${iterations}/${config.loop.maxIterations}. Start wrapping up — respond with text soon.]`
            : "";

      const messagesForLLM = budgetWarning
        ? [
            ...messages,
            {
              role: "user" as const,
              content: budgetWarning,
              timestamp: Date.now(),
            },
          ]
        : messages;

      // Think: call the LLM
      const llmResponse = await step.run(
        "think",
        async ({ systemPrompt: sp }: { systemPrompt: string }) => {
          const response = await callLLM(sp, messagesForLLM, tools);

          const rawContentBlocks = response.message.content.map((block) => {
            if (block.type === "text") return { type: "text", text: block.text.slice(0, 2000) };
            if (block.type === "toolCall")
              return { type: "toolCall", name: block.name, id: block.id };
            return { type: block.type };
          });

          return {
            ...response,
            rawContentBlocks,
            rawText: response.text.slice(0, 5000),
            provider: response.message.provider,
            model: response.message.model,
            api: response.message.api,
            errorMessage: response.message.errorMessage,
          };
        },
        { systemPrompt },
      );

      if (llmResponse.stopReason === "error") {
        const errMsg = llmResponse.message.errorMessage || llmResponse.text || "Unknown LLM error";
        const isOverflow =
          /context.?overflow|prompt.?too.?large|too many tokens|maximum context|token limit/i.test(
            errMsg,
          );

        if (isOverflow && !hasCompactedThisRun) {
          logger.warn("[loop] Context overflow detected, force-compacting...");
          hasCompactedThisRun = true;

          const keepCount = Math.min(6, messages.length);
          const toSummarize = messages.slice(0, messages.length - keepCount);
          const toKeep = messages.slice(-keepCount);

          if (toSummarize.length > 0) {
            const summaryText = toSummarize
              .map((m) => {
                const role = m.role.toUpperCase();
                const text = typeof m.content === "string" ? m.content : "[complex content]";
                return `${role}: ${text.slice(0, 200)}`;
              })
              .join("\n");

            messages.length = 0;
            messages.push({
              role: "user" as const,
              content: `[Previous conversation was too long and has been summarized]\n\n${summaryText.slice(0, 2000)}`,
              timestamp: Date.now(),
            });
            messages.push(...toKeep);
          }

          iterations--;
          continue;
        }

        throw new Error(`LLM error: ${errMsg}`);
      }

      const toolCalls = llmResponse.toolCalls;

      if (toolCalls.length > 0) {
        messages.push(llmResponse.message);

        if (llmResponse.text) {
          textParts.push(llmResponse.text);
        }

        // Incremental reply: send text alongside tool calls immediately
        if (config.incrementalReplies && llmResponse.text && loopChannel) {
          await step.sendEvent(`incremental-reply-${iterations}`, {
            name: "agent.reply.ready",
            data: {
              response: llmResponse.text,
              channel: loopChannel.channel,
              destination: loopChannel.destination,
              channelMeta: loopChannel.channelMeta,
            },
          });
          emittedTextParts.push(llmResponse.text);
        }

        // Act: execute each tool as a step
        for (const tc of toolCalls) {
          totalToolCalls++;
          logger.info({ tool: tc.name, toolCallId: tc.id }, `[loop] Executing tool: ${tc.name}`);

          let toolResult: ToolResult;

          if (tc.name === "delegate_task" && !options?.isSubAgent) {
            const subSessionKey = `sub-${sessionKey}-${Date.now()}`;
            const { subAgent } = await import("./functions/sub-agent.ts");
            const subResult = await step.invoke("sub-agent", {
              function: subAgent,
              data: {
                task: tc.arguments.task as string,
                subSessionKey,
                parentSessionKey: sessionKey,
              },
            });
            toolResult = {
              result: subResult?.response || "(Sub-agent returned no response)",
            };
          } else if (tc.name === "delegate_async_task" && !options?.isSubAgent) {
            const subSessionKey = `sub-${sessionKey}-${Date.now()}`;
            const asyncEvent = await step.sendEvent("spawn-async-sub-agent", {
              name: "agent.subagent.spawn",
              data: {
                task: tc.arguments.task as string,
                subSessionKey,
                parentSessionKey: sessionKey,
                async: true,
                ...(loopChannel
                  ? {
                      channel: loopChannel.channel,
                      destination: loopChannel.destination,
                      channelMeta: loopChannel.channelMeta,
                    }
                  : {}),
              },
            });
            const asyncEventId = asyncEvent?.ids?.[0] || "unknown";
            toolResult = {
              result: `Async sub-agent has been spawned (event ID: ${asyncEventId}). It will reply directly to the user when complete. Continue your conversation — do NOT wait for a result.`,
            };
          } else if (tc.name === "delegate_scheduled_task" && !options?.isSubAgent) {
            const subSessionKey = `sub-${sessionKey}-${Date.now()}`;
            const scheduledFor = tc.arguments.scheduledFor as string;
            const scheduledTs = new Date(scheduledFor).getTime();

            if (isNaN(scheduledTs)) {
              toolResult = {
                result: `Invalid scheduledFor timestamp: "${scheduledFor}". Must be a valid ISO 8601 timestamp.`,
                error: true,
              };
            } else {
              const scheduledEvent = await step.sendEvent("spawn-scheduled-sub-agent", {
                name: "agent.subagent.spawn",
                data: {
                  task: tc.arguments.task as string,
                  subSessionKey,
                  parentSessionKey: sessionKey,
                  async: true,
                  scheduledFor,
                  ...(loopChannel
                    ? {
                        channel: loopChannel.channel,
                        destination: loopChannel.destination,
                        channelMeta: loopChannel.channelMeta,
                      }
                    : {}),
                },
                ts: scheduledTs,
              });
              const scheduledEventId = scheduledEvent?.ids?.[0] || "unknown";
              const readableTime = new Date(scheduledTs).toLocaleString("en-US", {
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                timeZoneName: "short",
              });
              toolResult = {
                result: `Task scheduled for ${readableTime} (event ID: ${scheduledEventId}). The sub-agent will run at that time and reply directly to the user.`,
              };
            }
          } else {
            toolResult = await step.run(
              `tool-${tc.name}`,
              async ({ name, id, args }: ToolStepInput) => {
                const tool = tools.find((t) => t.name === name);
                if (tool) {
                  validateToolArguments(tool, {
                    type: "toolCall",
                    name,
                    id,
                    arguments: args,
                  });
                }
                return await executeTool(id, name, args);
              },
              { name: tc.name, id: tc.id, args: tc.arguments },
            );
          }

          // Observe: feed result back
          messages.push({
            role: "toolResult" as const,
            toolCallId: tc.id,
            toolName: tc.name,
            content: [{ type: "text" as const, text: toolResult.result }],
            isError: toolResult.error || false,
            timestamp: Date.now(),
          });
        }
      } else if (llmResponse.text) {
        textParts.push(llmResponse.text);
        finalResponse = textParts.join("\n\n");
        done = true;
      }

      logger.info(
        {
          iter: iterations,
          tools: toolCalls.length,
          stopReason: llmResponse.stopReason,
          provider: llmResponse.provider || config.llm.provider,
          model: llmResponse.model || config.llm.model,
          tokensIn: llmResponse.usage?.input || 0,
          tokensOut: llmResponse.usage?.output || 0,
          cost: llmResponse.usage?.cost?.total?.toFixed(4) || "?",
          rawText: llmResponse.text.slice(0, 500),
          contentBlockTypes:
            llmResponse.rawContentBlocks?.map((b: { type: string }) => b.type) || [],
          errorMessage: llmResponse.errorMessage || null,
        },
        `[loop] iter=${iterations} tools=${toolCalls.length} stop=${llmResponse.stopReason} tokens=${llmResponse.usage?.input || "?"}in/${llmResponse.usage?.output || "?"}out`,
      );
    }

    if (!done) {
      finalResponse =
        textParts.length > 0
          ? textParts.join("\n\n")
          : `(Reached max iterations: ${config.loop.maxIterations})`;
    }

    return {
      response: finalResponse,
      iterations,
      toolCalls: totalToolCalls,
      model: `${config.llm.provider}/${config.llm.model}`,
      incrementalRepliesSent: emittedTextParts.length,
      promptVersion,
    };
  };
}
