/** Tools — coding tools from pi-coding-agent + custom Utah tools (remember, web_fetch). */

import { Type } from "@mariozechner/pi-ai";
import type { Tool, TextContent } from "@mariozechner/pi-ai";
import {
  createReadTool,
  createEditTool,
  createWriteTool,
  createBashTool,
  createGrepTool,
  createFindTool,
  createLsTool,
} from "@mariozechner/pi-coding-agent";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { resolve, relative } from "path";
import { config } from "../config.ts";
import { appendDailyLog } from "./memory.ts";

const ALLOWED_WRITE_DIRS = new Set(["sessions", "memory", "scores", "prompts"]);

function isWriteAllowed(filePath: string): boolean {
  const absPath = resolve(config.workspace.root, filePath);
  const rel = relative(config.workspace.root, absPath);

  // Block writes outside the workspace entirely
  if (rel.startsWith("..")) return false;

  // Allow writes into known system directories
  const topDir = rel.split("/")[0];
  return ALLOWED_WRITE_DIRS.has(topDir);
}

const piTools: AgentTool<any>[] = [
  createReadTool(config.workspace.root),
  createEditTool(config.workspace.root),
  createWriteTool(config.workspace.root),
  createBashTool(config.workspace.root),
  createGrepTool(config.workspace.root),
  createFindTool(config.workspace.root),
  createLsTool(config.workspace.root),
];

const rememberTool: Tool = {
  name: "remember",
  description:
    "Save a note to today's daily log. Use ONLY for user-specific information: user preferences, facts about the user, project context, decisions, and task outcomes. Do NOT save behavioral instructions, tone guidance, or response quality feedback — those belong in the prompt versioning system.",
  parameters: Type.Object({
    note: Type.String({ description: "The note to save" }),
  }),
};

const webFetchTool: Tool = {
  name: "web_fetch",
  description: "Fetch a URL and return the response body as text",
  parameters: Type.Object({
    url: Type.String({ description: "URL to fetch" }),
  }),
};

const delegateTaskTool: Tool = {
  name: "delegate_task",
  description: `Delegate a self-contained task to a sub-agent that runs in an isolated context window.
Use this when:
- The task requires many file reads/edits (4+ tool calls expected)
- The task is independent and can be described as a clear goal
- You want to keep your own context lean
The sub-agent has access to the same workspace and tools but its own conversation.
You'll receive a summary of what it accomplished.`,
  parameters: Type.Object({
    task: Type.String({
      description:
        "Clear, detailed description of what the sub-agent should do. Include file paths, goals, and constraints.",
    }),
  }),
};

const delegateAsyncTaskTool: Tool = {
  name: "delegate_async_task",
  description: `Delegate a task to an async sub-agent that runs independently and replies directly to the user when done.
Use this when:
- The task is long-running or doesn't need to block your current conversation
- You want to continue interacting with the user while the task runs in the background
- The work is self-contained and the sub-agent can deliver results directly
The sub-agent runs in its own context, does the work, and sends its response directly to the user.
You will NOT receive the result — respond to the user acknowledging you've kicked it off.`,
  parameters: Type.Object({
    task: Type.String({
      description:
        "Clear, detailed description of what the sub-agent should do. Include file paths, goals, and constraints.",
    }),
  }),
};

const delegateScheduledTaskTool: Tool = {
  name: "delegate_scheduled_task",
  description: `Schedule a task for a sub-agent to run at a specific time in the future.
Use this when:
- The user wants something done at a later time ("check on this tomorrow", "run this at 5pm")
- A follow-up or reminder needs to execute with real work (not just a text reminder)
- Time-sensitive tasks that should run at a specific moment
The sub-agent will run at the scheduled time, do the work, and reply directly to the user.
You will NOT receive the result — respond to the user confirming what was scheduled and when.`,
  parameters: Type.Object({
    task: Type.String({
      description:
        "Clear, detailed description of what the sub-agent should do. Include file paths, goals, and constraints.",
    }),
    scheduledFor: Type.String({
      description:
        "ISO 8601 timestamp for when the task should run (e.g. '2026-03-10T09:00:00-05:00'). Use the current time from the system prompt and the user's timezone to calculate this.",
    }),
  }),
};

export const TOOLS: Tool[] = [
  ...piTools,
  rememberTool,
  webFetchTool,
  delegateTaskTool,
  delegateAsyncTaskTool,
  delegateScheduledTaskTool,
];

export const SUB_AGENT_TOOLS: Tool[] = [...piTools, rememberTool, webFetchTool];

const piToolMap = new Map<string, AgentTool>(piTools.map((t) => [t.name, t]));

export interface ToolResult {
  result: string;
  error?: boolean;
}

export async function executeTool(
  toolCallId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    if ((name === "write" || name === "edit") && args.path) {
      if (!isWriteAllowed(args.path as string)) {
        return {
          result: `Blocked: you are not allowed to create or edit files outside system directories (${[...ALLOWED_WRITE_DIRS].join(", ")}). Respond with text instead of writing files.`,
          error: true,
        };
      }
    }

    if (name === "bash" && args.command) {
      const cmd = args.command as string;
      const writesFile = /(?:>|tee\s|cat\s.*>|echo\s.*>|printf\s.*>)/.test(cmd);
      if (writesFile) {
        return {
          result: `Blocked: do not use bash to create files. Respond with text instead of writing files.`,
          error: true,
        };
      }
    }

    const piTool = piToolMap.get(name);
    if (piTool) {
      const result = await piTool.execute(toolCallId, args);
      const text = result.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n");

      return { result: text || "(no output)" };
    }

    switch (name) {
      case "remember": {
        await appendDailyLog(args.note as string);
        return { result: "Saved to today's log." };
      }
      case "web_fetch": {
        const res = await fetch(args.url as string, {
          signal: AbortSignal.timeout(30_000),
          headers: { "User-Agent": "Utah-Agent/1.0" },
        });
        const text = await res.text();
        return { result: text.slice(0, 50_000) };
      }
      default:
        return { result: `Unknown tool: ${name}`, error: true };
    }
  } catch (err) {
    return {
      result: `Error: ${err instanceof Error ? err.message : String(err)}`,
      error: true,
    };
  }
}
