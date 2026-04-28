# LLM Configuration (archived from SPEC.md)

*Archived: 2026-04-28 — Stable reference; key contract (two modes, provider/model convention) retained in Stack section.*

---

### LLM configuration

```bash
# .env

# Mode: "local" (Claude Code SDK) or "api" (Vercel AI SDK)
LLM_MODE=local

# --- API mode only (ignored when LLM_MODE=local) ---
# Models are specified as "provider/model" — provider is mandatory.
OPTIMIZER_MODEL=anthropic/claude-haiku-4-5     # fast/cheap for HTML optimization
REFINER_MODEL=anthropic/claude-opus-4-7        # stronger for textual refinement

# Examples for other providers:
# OPTIMIZER_MODEL=openai/gpt-5-mini
# REFINER_MODEL=google/gemini-2.5-pro
# REFINER_MODEL=mistral/mistral-large-latest
# REFINER_MODEL=ollama/llama3.1:70b

# Provider credentials (only the ones you actually use)
ANTHROPIC_API_KEY=...
# OPENAI_API_KEY=...
# GOOGLE_GENERATIVE_AI_API_KEY=...
# MISTRAL_API_KEY=...
# OLLAMA_BASE_URL=http://localhost:11434
```

The `provider/model` convention (inspired by [`anatoly`](../anatoly)) makes the routing explicit: the prefix selects which Vercel AI SDK provider package to load, the suffix is passed through to that provider untouched. Adding a new provider is purely a matter of installing its `@ai-sdk/<provider>` package and registering it in the transport registry — no other code changes.

In **local mode**, all LLM calls — both the optimizer and the refinement agent — are routed through the Claude Agent SDK, so you only need an active Claude Code login. In **API mode**, calls go through the Vercel AI SDK and any supported provider works.
