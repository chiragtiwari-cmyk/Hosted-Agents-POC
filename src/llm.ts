/**
 * Model access.
 *
 * The interface is deliberately narrow — two methods — so tests can inject a
 * scripted fake. No automated test reaches a provider or spends tokens.
 *
 * Two providers are supported, chosen by environment:
 *
 *   OPENAI_API_KEY set  → the OpenAI API directly (api.openai.com). This is the
 *                         default path for the workshop.
 *   otherwise           → Azure/Foundry models via DefaultAzureCredential, which
 *                         resolves to the hosted agent's managed identity when
 *                         deployed and to `az login` locally.
 *
 * The OpenAI path is simpler to run but note the trade-off: the container calls
 * out to api.openai.com with a secret, so the "dedicated Entra identity for model
 * calls" property of Foundry hosted agents is not exercised on that path.
 */
import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";
import OpenAI from "openai";

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Present on assistant messages that requested tools. */
  toolCalls?: LlmToolCall[];
  /** Present on tool messages, linking back to the request. */
  toolCallId?: string;
}

export interface LlmToolCall {
  id: string;
  name: string;
  /** Parsed arguments. Malformed JSON from the model becomes `{}`. */
  arguments: Record<string, unknown>;
}

export interface LlmCompletion {
  text: string;
  toolCalls: LlmToolCall[];
}

export interface LlmRequest {
  messages: LlmMessage[];
  tools?: unknown[];
  temperature?: number;
  maxTokens?: number;
}

export interface LlmClient {
  /** One completion, optionally with tools available. */
  complete(request: LlmRequest): Promise<LlmCompletion>;
  /** Single-shot text generation with a system prompt. Used by specialists. */
  phrase(system: string, user: string): Promise<string>;
}

const AZURE_AI_SCOPE = "https://ai.azure.com/.default";

export type ModelConfig =
  | { provider: "openai"; apiKey: string; model: string; baseUrl?: string }
  | { provider: "azure"; endpoint: string; deployment: string; apiVersion: string };

/**
 * Resolve provider config from the environment. OPENAI_API_KEY wins when present,
 * so the workshop can switch providers with one variable.
 */
export function readModelConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  if (env.OPENAI_API_KEY) {
    return {
      provider: "openai",
      apiKey: env.OPENAI_API_KEY,
      // MODEL_DEPLOYMENT_NAME is honoured so the same variable names the model on
      // both providers; OPENAI_MODEL is the clearer alias.
      model: env.OPENAI_MODEL ?? env.MODEL_DEPLOYMENT_NAME ?? "gpt-4o-mini",
      ...(env.OPENAI_BASE_URL ? { baseUrl: env.OPENAI_BASE_URL } : {}),
    };
  }

  const endpoint = env.FOUNDRY_PROJECT_ENDPOINT ?? env.AZURE_OPENAI_ENDPOINT;
  const deployment = env.MODEL_DEPLOYMENT_NAME;
  if (!endpoint) {
    throw new Error(
      "No model provider configured. Set OPENAI_API_KEY (with OPENAI_MODEL), or " +
        "FOUNDRY_PROJECT_ENDPOINT plus MODEL_DEPLOYMENT_NAME for Azure/Foundry models.",
    );
  }
  if (!deployment) {
    throw new Error("MODEL_DEPLOYMENT_NAME is not set (e.g. gpt-4.1-mini).");
  }
  return {
    provider: "azure",
    endpoint,
    deployment,
    apiVersion: env.AZURE_OPENAI_API_VERSION ?? "2024-10-21",
  };
}

/** The model name to report in protocol responses. */
export function modelNameOf(config: ModelConfig): string {
  return config.provider === "openai" ? config.model : config.deployment;
}

/**
 * Talks to Foundry-hosted models over the OpenAI-compatible surface, with an
 * Entra bearer token refreshed per request (the SDK caches underneath).
 */
/** Works against either provider — only client construction differs. */
export class ModelClient implements LlmClient {
  private client: OpenAI;
  private model: string;

  constructor(
    config: ModelConfig,
    credential: TokenCredential = new DefaultAzureCredential(),
  ) {
    this.model = modelNameOf(config);

    if (config.provider === "openai") {
      this.client = new OpenAI({
        apiKey: config.apiKey,
        ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      });
      return;
    }

    // Azure v1 API requires /openai/v1 in the path — not ?api-version=v1 as a
    // query param. Use the standard OpenAI client with a custom fetch that
    // injects an Entra bearer token on every request.
    const baseURL = `${config.endpoint.replace(/\/+$/, "")}/openai/v1`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entraFetch = async (url: any, init: any) => {
      const token = await credential.getToken(AZURE_AI_SCOPE);
      if (!token) throw new Error("Failed to acquire an Entra token for Foundry.");
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${token.token}`);
      return globalThis.fetch(url, { ...init, headers });
    };
    this.client = new OpenAI({
      baseURL,
      apiKey: "azure-entra-managed",
      fetch: entraFetch as unknown as OpenAI["fetch"],
    });
  }

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: request.messages.map(toOpenAiMessage) as never,
      tools: request.tools as never,
      max_completion_tokens: request.maxTokens ?? 800,
    });

    const choice = response.choices[0];
    const rawCalls = choice?.message?.tool_calls ?? [];
    return {
      text: choice?.message?.content ?? "",
      toolCalls: rawCalls.flatMap((call) => {
        if (!("function" in call) || !call.function) return [];
        return [
          {
            id: call.id,
            name: call.function.name,
            arguments: safeParseArgs(call.function.arguments),
          },
        ];
      }),
    };
  }

  async phrase(system: string, user: string): Promise<string> {
    const result = await this.complete({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.3,
      maxTokens: 400,
    });
    return result.text;
  }
}

function toOpenAiMessage(message: LlmMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

/** Models occasionally emit malformed tool arguments; treat that as empty. */
function safeParseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Retries a transient LLM failure once, then gives up. Wrapping the client
 * rather than the loop keeps retry policy in one place.
 */
export function withRetry(inner: LlmClient, attempts = 2): LlmClient {
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  };
  return {
    complete: (request) => run(() => inner.complete(request)),
    phrase: (system, user) => run(() => inner.phrase(system, user)),
  };
}
