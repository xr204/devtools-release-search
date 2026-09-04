import { InfraiSearchClient } from "./infrai_search_client";

const apiKey = process.env.INFRAI_API_KEY;
if (!apiKey) throw new Error("Set INFRAI_API_KEY before indexing release notes");

const collection = process.env.INFRAI_COLLECTION ?? "developer-release-notes";
const notes = [
  {
    id: "studio-2026-09-build-cache",
    title: "Build cache diagnostics for media previews",
    kind: "build_event",
    release: "2026.09",
    body: "Preview builds now report cache hit status, render duration, and the asset that caused an invalidation.",
  },
  {
    id: "studio-2026-09-publish-rollback",
    title: "Rollback markers in release operations",
    kind: "release_operation",
    release: "2026.09",
    body: "Publishing records the previous release marker so creator sites can return to the prior media bundle.",
  },
  {
    id: "studio-2026-08-codec-diagnostic",
    title: "Actionable codec mismatch message",
    kind: "developer_diagnostic",
    release: "2026.08",
    body: "Upload diagnostics identify the expected codec and the detected stream before a transcode starts.",
  },
];

const infrai = new InfraiSearchClient(apiKey);
const embedded = await Promise.all(notes.map(async (note) => ({
  id: note.id,
  values: await infrai.embed(`${note.title}\n${note.body}`),
  metadata: { title: note.title, kind: note.kind, release: note.release, body: note.body },
})));
const dimension = embedded[0]?.values.length;
if (!dimension) throw new Error("Embedding response did not contain a vector");

await infrai.createCollection(collection, dimension);
await infrai.upsert(collection, embedded);
console.log(`Indexed ${embedded.length} developer-tool records into ${collection}`);
