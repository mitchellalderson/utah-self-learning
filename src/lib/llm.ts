/** LLM — wrapper around pi-ai's complete() function. */

import { getModel, complete, validateToolArguments } from "@mariozechner/pi-ai";
import type {
  Tool,
  Message,
  AssistantMessage,
  KnownProvider,
  Model,
  TextContent,
  ToolCall,
} from "@mariozechner/pi-ai";
import { config } from "../config.ts";

export type { Tool, Message, AssistantMessage, TextContent, ToolCall };
export { validateToolArguments };

let _model: ReturnType<typeof getModel> | Model<"openai-completions"> | null = null;

export function getConfiguredModel() {
  if (!_model) {
    if (config.llm.openaiBaseUrl) {
      _model = {
        id: config.llm.model,
        name: config.llm.model,
        api: "openai-completions",
        provider: config.llm.provider || "openai",
        baseUrl: config.llm.openaiBaseUrl,
        reasoning: false,
        input: ["text"] as const,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 32_000,
      } satisfies Model<"openai-completions">;
    } else {
      _model = getModel(config.llm.provider as KnownProvider as any, config.llm.model as any);
      if (!_model) {
        throw new Error(
          `Unknown model "${config.llm.model}" for provider "${config.llm.provider}". Check AGENT_MODEL and LLM_PROVIDER env vars.`,
        );
      }
    }
  }
  return _model;
}

export interface LLMResponse {
  message: AssistantMessage;
  text: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  usage: AssistantMessage["usage"];
  stopReason: AssistantMessage["stopReason"];
}

export async function callLLM(
  system: string,
  messages: Message[],
  tools: Tool[],
): Promise<LLMResponse> {
  const model = getConfiguredModel();

  const result = await complete(model, {
    systemPrompt: system,
    messages,
    tools,
  });

  const text = result.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("");

  const toolCalls = result.content
    .filter((c): c is ToolCall => c.type === "toolCall")
    .map((c) => ({ id: c.id, name: c.name, arguments: c.arguments || {} }));

  return {
    message: result,
    text,
    toolCalls,
    usage: result.usage,
    stopReason: result.stopReason,
  };
}
