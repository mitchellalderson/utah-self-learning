/** Compaction — when conversation gets too long, older messages are LLM-summarized. */

import { callLLM } from "./llm.ts";
import { loadSession, writeSession, type SessionMessage } from "./session.ts";
import { config } from "../config.ts";
import type { Logger } from "inngest";

const SUMMARIZATION_SYSTEM_PROMPT =
  "You are a summarization assistant. Create concise, structured summaries that preserve all important context, decisions, and progress.";

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

function estimateMessageTokens(msg: SessionMessage): number {
  const chars = msg.content.length;
  return Math.ceil(chars / 4);
}

export function estimateTokens(messages: SessionMessage[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}

export function shouldCompact(messages: SessionMessage[]): boolean {
  const estimated = estimateTokens(messages);
  return estimated > config.compaction.maxTokens * config.compaction.threshold;
}

function serializeConversation(messages: SessionMessage[]): string {
  return messages
    .map((msg) => {
      const role = msg.role.toUpperCase();
      return `${role}: ${msg.content}`;
    })
    .join("\n\n");
}

export async function runCompaction(
  messages: SessionMessage[],
  sessionKey: string,
  logger: Logger,
): Promise<SessionMessage[]> {
  let recentTokens = 0;
  let cutIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    recentTokens += estimateMessageTokens(messages[i]);
    if (recentTokens >= config.compaction.keepRecentTokens) {
      cutIndex = i;
      break;
    }
  }

  if (cutIndex <= 1) return messages;

  const toSummarize = messages.slice(0, cutIndex);
  const toKeep = messages.slice(cutIndex);

  const conversationText = serializeConversation(toSummarize);
  const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${SUMMARIZATION_PROMPT}`;

  const response = await callLLM(
    SUMMARIZATION_SYSTEM_PROMPT,
    [{ role: "user" as const, content: promptText, timestamp: Date.now() }],
    [], // no tools for summarization
  );

  const summaryText = response.text;

  const summaryMessage: SessionMessage = {
    role: "user",
    content: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summaryText}\n</summary>`,
    timestamp: new Date().toISOString(),
  };

  const compacted = [summaryMessage, ...toKeep];

  await writeSession(sessionKey, compacted);

  logger.info(
    {
      before: messages.length,
      after: compacted.length,
      summarized: toSummarize.length,
      kept: toKeep.length,
    },
    `[compaction] ${messages.length} messages → ${compacted.length}`,
  );

  return compacted;
}
