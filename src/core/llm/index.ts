import type { LlmTransport } from "./types.js";
import type { LlmConfig } from "../config.js";
import { ClaudeCodeTransport } from "./claude-code.js";
import { VercelAiTransport } from "./vercel-ai.js";

export type { LlmCall, LlmResponse, LlmTransport } from "./types.js";

export function createTransport(config: LlmConfig): LlmTransport {
  return config.mode === "local" ? new ClaudeCodeTransport() : new VercelAiTransport();
}

export interface GenerateOptions {
  systemPrompt?: string;
  /** Overrides config.optimizerModel when provided. */
  model?: string;
  abortSignal?: AbortSignal;
  /** Inject a transport (used by tests); defaults to `createTransport(config)`. */
  transport?: LlmTransport;
}

/**
 * Thin convenience wrapper: pick the configured transport and forward a
 * single prompt. The transport abstraction stays the same; this exists
 * so callers don't need to construct an `LlmCall` by hand.
 */
export async function generate(
  prompt: string,
  config: LlmConfig,
  options: GenerateOptions = {},
): Promise<string> {
  const transport = options.transport ?? createTransport(config);
  const result = await transport.query({
    userMessage: prompt,
    systemPrompt: options.systemPrompt ?? "",
    model: options.model ?? config.optimizerModel,
    abortSignal: options.abortSignal,
  });
  return result.text;
}
