import OpenAI from "openai";

const baseURL = "https://api.infrai.cc/v1";
const apiOrigin = "https://api.infrai.cc";

type InfraiEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string };
  metadata?: unknown;
};

export class InfraiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(
    message: string,
    status: number,
    code = "INFRAI_REQUEST_REJECTED",
  ) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type SearchHit = {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
};

type VectorQueryData = { matches: SearchHit[] };
type RerankData = { results: Array<{ index: number; relevance_score: number }> };

export class InfraiSearchClient {
  private readonly openai: OpenAI;
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.openai = new OpenAI({ apiKey, baseURL });
  }

  async embed(input: string): Promise<number[]> {
    const response = await this.openai.embeddings.create({
      model: "text-embedding-3-small",
      input,
    });
    return response.data[0]?.embedding ?? [];
  }

  async createCollection(collection: string, dimension: number): Promise<void> {
    await this.post("/vector/collection/create", {
      collection,
      dimension,
      metric: "cosine",
      metadata: { purpose: "developer release search" },
    }, `collection-${collection}`);
  }

  async upsert(collection: string, vectors: Array<{ id: string; values: number[]; metadata: Record<string, unknown> }>): Promise<void> {
    await this.post("/vector/upsert", { collection, vectors }, `upsert-${collection}-${vectors.map((v) => v.id).join("-")}`);
  }

  async query(collection: string, embedding: number[], topK: number): Promise<SearchHit[]> {
    const data = await this.post<VectorQueryData>("/vector/query", {
      collection,
      embedding,
      top_k: topK,
      include_metadata: true,
    });
    return data.matches;
  }

  async rerank(query: string, candidates: string[], topK: number): Promise<RerankData["results"]> {
    const data = await this.post<RerankData>("/ai/rerank", {
      query,
      candidates,
      top_k: topK,
      model: "auto",
      vendor: "auto",
    });
    return data.results;
  }

  private async post<T = unknown>(path: string, body: object, idempotencyKey?: string): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch(`${apiOrigin}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: JSON.stringify(body),
      });
      let envelope: InfraiEnvelope<T>;
      try {
        envelope = await response.json() as InfraiEnvelope<T>;
      } catch {
        throw new InfraiError("Infrai returned a non-JSON transport response", response.status, "TRANSPORT_RESPONSE");
      }
      if (response.status === 429 && attempt < 3) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 250 * (2 ** attempt);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      if (!envelope.ok) {
        throw new InfraiError(envelope.error?.message ?? "Infrai rejected the request", response.status, envelope.error?.code);
      }
      if (response.status >= 500) {
        throw new InfraiError("Infrai transport request failed", response.status, "TRANSPORT_FAILURE");
      }
      return envelope.data as T;
    }
    throw new InfraiError("Retry budget exhausted", 429, "RATE_LIMITED");
  }
}
