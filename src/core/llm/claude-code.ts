import type { LlmCall, LlmResponse, LlmTransport } from "./types.js";
import { stripProvider } from "../config.js";

/**
 * Local-mode transport: routes calls through the Claude Agent SDK,
 * reusing the user's local Claude Code session (no API key required).
 */
export class ClaudeCodeTransport implements LlmTransport {
  async query(call: LlmCall): Promise<LlmResponse> {
    // Lazy import keeps the SDK out of the API-mode hot path.
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    const ac = new AbortController();
    if (call.abortSignal) {
      call.abortSignal.addEventListener("abort", () => ac.abort(), { once: true });
    }

    const q = query({
      prompt: call.userMessage,
      options: {
        systemPrompt: call.systemPrompt,
        model: stripProvider(call.model),
        allowedTools: [],
        maxTurns: 1,
        permissionMode: "bypassPermissions",
        abortController: ac,
      },
    });

    let text = "";
    for await (const message of q) {
      if (message.type === "result" && message.subtype === "success") {
        text = message.result ?? "";
      }
    }
    return { text };
  }
}
