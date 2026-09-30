// OpenAPI 3.1 document for the language-neutral AI-service contract (ADR-018). Generated from the same capability table the
// TypeScript client uses (@cnote/ai/remote), so the spec cannot drift from the implementation. A Python port only has to
// satisfy this document. Export: `pnpm --filter @cnote/ai-service openapi` -> docs/design/ai-service.openapi.json.
import { AI_CAPABILITIES, AI_SERVICE_AUDIENCE } from "@cnote/ai/remote";

const errorResponse = (description: string) => ({ description, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } });

export function buildOpenApi(version = "1.0.0") {
  const paths: Record<string, unknown> = {
    "/health": { get: { summary: "Liveness", security: [], responses: { "200": { description: "Process is up" } } } },
    "/ready": {
      get: {
        summary: "Readiness (token secret configured, provider credentials present, not shedding load)", security: [],
        responses: { "200": { description: "Ready" }, "503": errorResponse("Not ready") },
      },
    },
  };
  for (const [name, cap] of Object.entries(AI_CAPABILITIES)) {
    paths[cap.path] = {
      post: {
        operationId: name, summary: cap.summary, tags: ["capabilities"],
        description: `Idempotent: ${cap.retry ? "yes, clients may retry on 5xx/timeout" : "NO, clients must not retry (metered); the queue consumer owns retries"}.`,
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CapabilityRequest" } } } },
        responses: {
          "200": { description: "Provider result", content: { "application/json": { schema: { $ref: "#/components/schemas/ProviderResult" } } } },
          "401": errorResponse("Missing/invalid/expired service token or wrong audience"),
          "413": errorResponse("Body too large"),
          "422": errorResponse("Input rejected by the capability"),
          "500": errorResponse("Internal or vendor error (retryable)"),
          "503": errorResponse("Overloaded (Retry-After set); callers fall back or retry"),
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "cnote AI-Orchestration service", version,
      description:
        "Provider-level AI capabilities (ADR-018). Callers keep decision logging, review routing and audit redaction; this service only runs the provider call. " +
        "Binary fields (images, audio) are encoded as `{ \"$base64\": \"...\" }` anywhere in the input. Every response carries `X-Request-Id`.",
    },
    servers: [{ url: "http://ai-service.internal:3005" }],
    security: [{ serviceToken: [] }],
    paths,
    components: {
      securitySchemes: {
        serviceToken: {
          type: "http", scheme: "bearer", bearerFormat: "JWT",
          description: `HS256 JWT signed with AI_SERVICE_TOKEN_SECRET. Claims: iss (caller name), aud="${AI_SERVICE_AUDIENCE}", iat, exp (<= 300s, default 60s), jti. Clock skew tolerance 5s. Secret may be a comma list for rotation.`,
        },
      },
      schemas: {
        CapabilityRequest: {
          type: "object", required: ["input"],
          properties: { input: { type: "object", description: "Capability input; identical to the @cnote/ai TypeScript input type. /v1/embed takes { texts: string[] } (max 256)." } },
        },
        ProviderResult: {
          type: "object", required: ["output", "confidence", "provider", "modelId", "promptVersion"],
          properties: {
            output: { description: "Capability output; identical to the @cnote/ai TypeScript output type. /v1/embed returns { vectors: number[][], version: string }." },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            provider: { type: "string", description: "heuristic | anthropic | sarvam | ...; clients set heuristic-fallback when they answered locally" },
            modelId: { type: "string" },
            promptVersion: { type: "string" },
          },
        },
        Error: {
          type: "object", required: ["error"],
          properties: { error: { type: "object", required: ["code", "message", "requestId"], properties: { code: { type: "string" }, message: { type: "string" }, requestId: { type: "string" } } } },
        },
      },
    },
  };
}
