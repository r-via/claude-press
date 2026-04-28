import { describe, it, expect, vi } from "vitest";
import { createTransport, generate } from "./llm/index.js";
import { ClaudeCodeTransport } from "./llm/claude-code.js";
import { VercelAiTransport } from "./llm/vercel-ai.js";
import type { LlmConfig } from "./config.js";
import type { LlmCall, LlmResponse, LlmTransport } from "./llm/types.js";

const baseConfig: LlmConfig = {
  mode: "local",
  optimizerModel: "anthropic/claude-haiku-4-5",
  refinerModel: "anthropic/claude-opus-4-7",
};

class FakeTransport implements LlmTransport {
  public calls: LlmCall[] = [];
  constructor(private response: string = "ok") {}
  async query(call: LlmCall): Promise<LlmResponse> {
    this.calls.push(call);
    return { text: this.response };
  }
}

describe("createTransport", () => {
  it("returns ClaudeCodeTransport for local mode", () => {
    const t = createTransport({ ...baseConfig, mode: "local" });
    expect(t).toBeInstanceOf(ClaudeCodeTransport);
  });

  it("returns VercelAiTransport for api mode", () => {
    const t = createTransport({ ...baseConfig, mode: "api" });
    expect(t).toBeInstanceOf(VercelAiTransport);
  });
});

describe("generate", () => {
  it("forwards prompt, system prompt and configured model to the transport", async () => {
    const fake = new FakeTransport("hello world");
    const text = await generate("write a poem", baseConfig, {
      systemPrompt: "you are a poet",
      transport: fake,
    });
    expect(text).toBe("hello world");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      userMessage: "write a poem",
      systemPrompt: "you are a poet",
      model: baseConfig.optimizerModel,
    });
  });

  it("respects model override", async () => {
    const fake = new FakeTransport();
    await generate("x", baseConfig, { transport: fake, model: "openai/gpt-5-mini" });
    expect(fake.calls[0].model).toBe("openai/gpt-5-mini");
  });

  it("propagates transport errors", async () => {
    const broken: LlmTransport = {
      query: vi.fn().mockRejectedValue(new Error("boom")),
    };
    await expect(generate("x", baseConfig, { transport: broken })).rejects.toThrow("boom");
  });
});
