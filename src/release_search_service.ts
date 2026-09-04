import express from "express";
import { z } from "zod";
import { InfraiError, InfraiSearchClient } from "./infrai_search_client";
import { publishSearchResults } from "./search_decision";

const SearchRequest = z.object({
  query: z.string().trim().min(3).max(240),
  limit: z.number().int().min(1).max(10).default(5),
});

const apiKey = process.env.INFRAI_API_KEY;
if (!apiKey) throw new Error("Set INFRAI_API_KEY before starting the service");

const collection = process.env.INFRAI_COLLECTION ?? "developer-release-notes";
const infrai = new InfraiSearchClient(apiKey);
const service = express();
service.use(express.json({ limit: "16kb" }));

service.post("/search", async (request, response) => {
  const parsed = SearchRequest.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid search request", details: parsed.error.flatten() });
    return;
  }

  try {
    const embedding = await infrai.embed(parsed.data.query);
    const hits = await infrai.query(collection, embedding, parsed.data.limit * 2);
    const candidates = hits.map((hit) => String(hit.metadata?.body ?? hit.metadata?.title ?? hit.id));
    const ranked = await infrai.rerank(parsed.data.query, candidates, parsed.data.limit);
    response.json({ query: parsed.data.query, results: publishSearchResults(hits, ranked) });
  } catch (error) {
    if (error instanceof InfraiError) {
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      response.status(status).json({ error: error.message, code: error.code });
      return;
    }
    response.status(500).json({ error: "Search request could not be completed" });
  }
});

const port = Number(process.env.PORT ?? 3000);
service.listen(port, () => console.log(`Developer release search listening on http://localhost:${port}`));
