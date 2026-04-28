import type { LanguageModel } from "ai";
import type { LlmCall, LlmResponse, LlmTransport } from "./types.js";
import { extractProvider, stripProvider } from "../config.js";

type ProviderFactory = (modelId: string) => LanguageModel;

const providers: Record<string, () => Promise<ProviderFactory>> = {
  anthropic: async () => {
    const mod = await import("@ai-sdk/anthropic");
    return (id) => mod.anthropic(id);
  },
  // Add more providers here as their packages are installed:
  // openai: async () => { const m = await import("@ai-sdk/openai"); return (id) => m.openai(id); },
  // google: async () => { const m = await import("@ai-sdk/google"); return (id) => m.google(id); },
  // mistral: async () => { const m = await import("@ai-sdk/mistral"); return (id) => m.mistral(id); },
};

/**
 * API-mode transport: routes calls through the Vercel AI SDK.
 * Provider is selected from the "provider/" prefix in the model string.
 */
export class VercelAiTransport implements LlmTransport {
  async query(call: LlmCall): Promise<LlmResponse> {
    const providerId = extractProvider(call.model);
    const factory = providers[providerId];
    if (!factory) {
      throw new Error(
        `Provider "${providerId}" is not registered. Install @ai-sdk/${providerId} and add it to vercel-ai.ts`,
      );
    }
    const buildModel = await factory();
    const model = buildModel(stripProvider(call.model));

    const { generateText } = await import("ai");
    const result = await generateText({
      model,
      system: call.systemPrompt,
      prompt: call.userMessage,
      abortSignal: call.abortSignal,
    });

    return { text: result.text };
  }
}
