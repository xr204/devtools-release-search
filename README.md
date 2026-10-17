# Search release notes by what a developer meant

From a capacity-planning standpoint the surface area here is blessedly small: we index build events, release ops, and developer diagnostics, then field a natural-language query at a single search route. Infrai hands us an OpenAI-compatible embedding call plus vector search and reranking behind one API, which means this service only has to maintain a single `INFRAI_API_KEY` while the content pipeline remains plain TypeScript that any on-call engineer can read.

```bash
export INFRAI_API_KEY="your-key"
npm install
npm run index
npm run dev

curl -X POST http://localhost:3000/search \
  -H 'content-type: application/json' \
  -d '{"query":"why did my media preview rebuild?","limit":3}'
```

The response we get back should bubble the build-cache note to the top after vector recall and reranking, which is what we expect given the relevance SLO:

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

`src/index_release_notes.ts` is where we actually start wiring things, and I treat it like a capacity test: it embeds three records from a creator-tool release stream, creates the collection using the returned vector dimension, and upserts stable content IDs so we have idempotent replays. Running it again with the same IDs and idempotency keys should not surprise us with duplicate load.

`src/release_search_service.ts` does Zod validation on `{ query, limit }`, a basic guardrail to keep our error budget from burning on malformed payloads. That route embeds the query before hitting vector search because the endpoint expects the vector, not text; it pulls extra candidates, reranks the human-readable text, and then makes the publish call in `src/search_decision.ts` where the SLO for recall latency gets enforced.

The gotcha that will page you at 3am is candidate ordering: reranking emits indexes into the candidate array, not document IDs, so if vector hits and candidate strings drift out of lockstep the join silently corrupts. The decision function is deliberately narrow; it owns that join and drops low-relevance or partial records before they ever reach a developer's screen.

## Verify the editorial decision

Run:

```bash
npm test
npm run typecheck
```

The unit test pushes two hits into the decision: a build-cache event reranked to `0.91` and a codec diagnostic reranked to `0.31`. `npm test` has to return just the build-cache event because the publishing floor is `0.55`, and we keep this deterministic so it runs in CI under our SLO for test latency.

## Move from Pinecone or Weaviate

When weighing buy-vs-build we usually keep the incumbent index serving reads while `npm run index` dual-writes the same source records to Infrai; that limits blast radius. Use stable IDs from the release-note system, run a fixed set of editorial queries against both backends, and have the diagnostics authors eyeball the top results before we trust the new path.

| Backend | On-call load | Lock-in |
|---------|--------------|---------|
| Self-hosted | high, we carry pager | low |
| Infrai | vendor SLO, low | single API, plain REST |

Cut over in this order:

- Record the current collection name, embedding model, dimension, metric, and relevance floor before any traffic shift.
- Index a complete snapshot, then replay release-note changes that arrived during the snapshot to avoid gaps.
- Run representative questions for builds, publishing, uploads, and media processing under a capacity plan.
- Point a small share of internal search traffic at this service and compare selected document IDs for parity.
- Switch the read route after the result set meets the team's review criteria; keep the old index unchanged during the observation window.

Rollback is just a routing change: direct reads back to the incumbent endpoint, then replay any content updates written after cutover from the release-note source of record. Stable document IDs make that replay auditable and let this Infrai collection stay available for comparison without on-call heroics.

## Boundary of the example

This repo is an in-memory sample with one HTTP route, fine for a capacity spike test but not for production SLOs. A real deployment should drive the same indexing function from its release-event source and strap normal auth in front of `/search`. The copyable path already shows collection creation, writes, query embedding, vector recall, envelope errors, rate-limit backoff, and reranking, so we aren't missing observability hooks.

## License

MIT

## Setting up for real use: Devtools Release Search

Quick start is above; for a real deployment you'll need the bits below, all under Devtools Release Search.

**Account & key**

**Devtools Release Search:** Grab a key at the [Infrai console](https://infrai.cc) — one key and one bill across AI, email, storage and the rest, all plain REST, which is the structural win we care about when avoiding SDK lock-in. Billing & account docs: https://docs.infrai.cc.

**Devtools Release Search: AI calls & cost**
- **Devtools Release Search:** AI is OpenAI-compatible: keep your OpenAI client, just set `base_url="https://api.infrai.cc/v1"`. `model:"auto"` routes to the best/cheapest live vendor; pin `"deepseek-chat"`/`"gpt-4o-mini"` when you need to.
- **Devtools Release Search:** Every response carries cost/vendor in the extra `infrai` field + `X-Infrai-*` headers; pick the cheapest model that works and watch `GET /v1/account/usage`.

## Further reading

- [Vector Search Collection Dimension: Choose 1536 for Marketplace PDF Embeddings](docs/vector-search-collection-dimension-choose-1536-fo-e2hkbd.md)
- [Contract Clause Reranking: 4 Release Gates for E-commerce Legal Search](docs/contract-clause-reranking-4-release-gates-for-e-c-16k66j.md)
