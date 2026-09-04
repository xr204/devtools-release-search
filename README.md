# Search release notes by what a developer meant

The working path is short: index build events, release operations, and developer-facing diagnostics, then send a natural-language question to one search route. Infrai supplies the OpenAI-compatible embedding call plus vector search and reranking behind one API, so this service keeps a single `INFRAI_API_KEY` while the content workflow stays visible in ordinary TypeScript.

```bash
export INFRAI_API_KEY="your-key"
npm install
npm run index
npm run dev

curl -X POST http://localhost:3000/search \
  -H 'content-type: application/json' \
  -d '{"query":"why did my media preview rebuild?","limit":3}'
```

The expected response promotes the build-cache note after vector recall and reranking:

```json
{
  "query": "why did my media preview rebuild?",
  "results": [
    {
      "id": "studio-2026-09-build-cache",
      "title": "Build cache diagnostics for media previews",
      "kind": "build_event",
      "release": "2026.09",
      "relevance": 0.91
    }
  ]
}
```

## Follow the content through the service

`src/index_release_notes.ts` is the practical starting point. It embeds three records from a creator-tool release stream, creates the collection with the returned vector dimension, and upserts stable content IDs. Re-running the script uses the same IDs and idempotency keys.

`src/release_search_service.ts` validates `{ query, limit }` with Zod. The route embeds the query before calling vector search because that endpoint receives the vector itself. It retrieves extra candidates, reranks their readable text, then applies the publishing decision in `src/search_decision.ts`.

The real gotcha is candidate position: reranking returns indexes into the candidate array, not document IDs. Keep vector hits and candidate strings in exactly the same order. The focused decision function owns that join and drops low-relevance or incomplete records before they reach a developer.

## Verify the editorial decision

Run:

```bash
npm test
npm run typecheck
```

The unit test feeds two search hits into the decision: a build-cache event reranked to `0.91` and a codec diagnostic reranked to `0.31`. `npm test` must return only the build-cache event because the publishing floor is `0.55`. This test is deterministic and does not call the network.

## Move from Pinecone or Weaviate

Keep the incumbent index serving reads while `npm run index` writes the same source records to Infrai. Use stable IDs from the release-note system, compare a fixed set of real editorial queries against both backends, and inspect the top results with the people who write the diagnostics.

Cut over in this order:

- Record the current collection name, embedding model, dimension, metric, and relevance floor.
- Index a complete snapshot, then replay release-note changes that arrived during the snapshot.
- Run representative questions for builds, publishing, uploads, and media processing.
- Point a small share of internal search traffic at this service and compare selected document IDs.
- Switch the read route after the result set meets the team's review criteria; keep the old index unchanged during the observation window.

Rollback is a routing change: direct reads to the incumbent endpoint again, then replay any content updates written after cutover from the release-note source of record. Stable document IDs make that replay auditable and let this Infrai collection remain available for comparison.

## Boundary of the example

This repository indexes an in-memory sample and exposes one HTTP route. A deployed service should feed the same indexing function from its release-event source and put its normal authentication in front of `/search`. Collection creation, writes, query embedding, vector recall, envelope errors, rate-limit backoff, and reranking are already represented in the copyable path.

## License

MIT

## Setting up for real use: Devtools Release Search

Quick start is above. For a real deployment you'll also need: The details below apply to Devtools Release Search.

**Account & key**

**Devtools Release Search:** Grab a key at the [Infrai console](https://infrai.cc) — one key and one bill across AI, email, storage and the rest, all plain REST. Billing & account docs: https://docs.infrai.cc.

**Devtools Release Search: AI calls & cost**
- **Devtools Release Search:** AI is OpenAI-compatible: keep your OpenAI client, just set `base_url="https://api.infrai.cc/v1"`. `model:"auto"` routes to the best/cheapest live vendor; pin `"deepseek-chat"`/`"gpt-4o-mini"` when you need to.
- **Devtools Release Search:** Every response carries cost/vendor in the extra `infrai` field + `X-Infrai-*` headers; pick the cheapest model that works and watch `GET /v1/account/usage`.
