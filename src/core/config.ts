export interface CrawlerConfig {
  concurrency: number;
  delayMs: number;
  userAgent: string;
  respectRobots: boolean;
}

export interface LlmConfig {
  mode: "local" | "api";
  optimizerModel: string;
  refinerModel: string;
}

export interface AppConfig {
  llm: LlmConfig;
  crawler: CrawlerConfig;
}

export function loadConfig(): AppConfig {
  const mode = (process.env.LLM_MODE ?? "local") as LlmConfig["mode"];
  if (mode !== "local" && mode !== "api") {
    throw new Error(`LLM_MODE must be "local" or "api", got "${mode}"`);
  }

  return {
    llm: {
      mode,
      optimizerModel: process.env.OPTIMIZER_MODEL ?? "anthropic/claude-haiku-4-5",
      refinerModel: process.env.REFINER_MODEL ?? "anthropic/claude-opus-4-7",
    },
    crawler: {
      concurrency: Number(process.env.CRAWL_CONCURRENCY ?? 8),
      delayMs: Number(process.env.CRAWL_DELAY_MS ?? 200),
      userAgent: process.env.CRAWL_USER_AGENT ?? "claude-press/0.0.1",
      respectRobots: (process.env.CRAWL_RESPECT_ROBOTS ?? "true") === "true",
    },
  };
}

export function extractProvider(model: string): string {
  const idx = model.indexOf("/");
  if (idx === -1) {
    throw new Error(
      `Model "${model}" must be in "provider/model" format (e.g. "anthropic/claude-opus-4-7")`,
    );
  }
  return model.slice(0, idx);
}

export function stripProvider(model: string): string {
  const idx = model.indexOf("/");
  return idx === -1 ? model : model.slice(idx + 1);
}
