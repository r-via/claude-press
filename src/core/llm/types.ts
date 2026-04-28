export interface LlmCall {
  systemPrompt: string;
  userMessage: string;
  /** "provider/model" string. Ignored in local mode. */
  model: string;
  abortSignal?: AbortSignal;
}

export interface LlmResponse {
  text: string;
}

export interface LlmTransport {
  query(call: LlmCall): Promise<LlmResponse>;
}
