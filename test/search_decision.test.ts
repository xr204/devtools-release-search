import assert from "node:assert/strict";
import test from "node:test";
import { publishSearchResults } from "../src/search_decision";

test("publishes only reranked developer diagnostics above the relevance floor", () => {
  const hits = [
    { id: "codec", score: 0.7, metadata: { title: "Codec mismatch", kind: "developer_diagnostic", release: "2026.08" } },
    { id: "cache", score: 0.8, metadata: { title: "Build cache", kind: "build_event", release: "2026.09" } },
  ];
  const result = publishSearchResults(hits, [
    { index: 1, relevance_score: 0.91 },
    { index: 0, relevance_score: 0.31 },
  ]);

  assert.deepEqual(result, [{
    id: "cache",
    title: "Build cache",
    kind: "build_event",
    release: "2026.09",
    relevance: 0.91,
  }]);
});
