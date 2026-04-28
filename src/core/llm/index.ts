import type { LlmTransport } from "./types.js";
import type { LlmConfig } from "../config.js";
import { ClaudeCodeTransport } from "./claude-code.js";
import { VercelAiTransport } from "./vercel-ai.js";

export type { LlmCall, LlmResponse, LlmTransport } from "./types.js";

export function createTransport(config: LlmConfig): LlmTransport {
  return config.mode === "local" ? new ClaudeCodeTransport() : new VercelAiTransport();
}
