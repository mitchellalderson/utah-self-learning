import { resolve } from "path";

export const config = {
  agent: {
    name: process.env.AGENT_NAME || "Utah",
  },

  workspace: {
    root: resolve(process.env.AGENT_WORKSPACE || "./workspace"),
    sessionDir: "sessions",
    memoryFile: "MEMORY.md",
    memoryDir: "memory",
  },

  llm: {
    // pi-ai provider/model format — supports "anthropic", "openai", "google"
    provider: (process.env.LLM_PROVIDER || "anthropic") as "anthropic" | "openai" | "google",
    model: process.env.AGENT_MODEL || "claude-sonnet-4-20250514",
    // API keys are read from env by pi-ai automatically:
    //   ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY
    // Optional: override the OpenAI base URL for compatible APIs (e.g. Ollama, LiteLLM, vLLM)
    openaiBaseUrl: process.env.OPENAI_BASE_URL || "",
  },

  loop: {
    maxIterations: 20,
  },

  compaction: {
    // Estimated token limit before compaction triggers
    maxTokens: 150_000,
    // Compact when estimated tokens exceed this fraction of maxTokens
    threshold: 0.8,
    // Keep this many estimated tokens of recent messages verbatim
    keepRecentTokens: 20_000,
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    allowedChatIds: (process.env.TELEGRAM_ALLOWED_CHATS || "").split(",").filter(Boolean),
  },

  slack: {
    botToken: process.env.SLACK_BOT_TOKEN || "",
    signingSecret: process.env.SLACK_SIGNING_SECRET || "",
  },

  incrementalReplies: process.env.AGENT_INCREMENTAL_REPLIES === "true",

  scoring: {
    enabled: process.env.SCORING_ENABLED !== "false",
    provider: (process.env.SCORING_PROVIDER || "anthropic") as "anthropic" | "openai",
    model: process.env.SCORING_MODEL || "claude-3-5-haiku-20241022",
  },

  prompts: {
    versioningEnabled: process.env.PROMPT_VERSIONING_ENABLED !== "false",
  },

  evaluation: {
    cron: process.env.EVALUATION_CRON || "0 */6 * * *",
    minDataPoints: parseInt(process.env.EVAL_MIN_DATA_POINTS || "10"),
    targetComposite: parseFloat(process.env.EVAL_TARGET_COMPOSITE || "7.0"),
    maxVersions: parseInt(process.env.EVAL_MAX_VERSIONS || "5"),
    newVersionWeight: parseFloat(process.env.EVAL_NEW_VERSION_WEIGHT || "0.5"),
    promotionTrafficThreshold: parseFloat(process.env.EVAL_PROMOTION_TRAFFIC || "0.6"),
    promotionScoreGap: parseFloat(process.env.EVAL_PROMOTION_SCORE_GAP || "0.3"),
    significantGap: parseFloat(process.env.EVAL_SIGNIFICANT_GAP || "1.0"),
  },
};
