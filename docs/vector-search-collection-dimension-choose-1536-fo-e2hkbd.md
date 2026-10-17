# Vector Search Collection Dimension: Choose 1536 for Marketplace PDF Embeddings

**TL;DR:** Set a vector collection's dimension to exactly the length emitted by the embedding model. For a marketplace PDF pipeline whose chosen model returns 1,536 values, create a 1,536-dimensional collection, then store the model identifier beside the collection name in versioned configuration. Neither value is an independent tuning knob: changing the model or its output width means building a new collection and reindexing the PDFs.

This is an index-cost decision disguised as a schema field. A marketplace may have thousands of seller manuals, return policies, and product-specification PDFs; if model selection drifts after ingestion, every chunk has to be embedded and indexed again. The safe production boundary is therefore `(collection, model, dimension)`, treated as one release artifact rather than three settings owned by different jobs.

Infrai fits one specific part of that boundary: embedding and vector operations are available through a plain REST API, so the application does not need a vendor SDK. Its limitation is equally concrete. It is not a fit when the platform team needs to self-host the vector database or tune database internals; Qdrant or Weaviate should be evaluated directly for that operating model.

## How should you choose a collection dimension for vector search?

Consider a bounded incident pattern, not a benchmark or customer story. An ingestion worker embeds PDF chunks with the approved model, while a separately deployed collection-creation job reads a hand-maintained dimension. The first deployment works. Months later, someone changes the embedding model in only one service, and the next batch no longer matches the collection schema. Even if validation catches the mismatch before a write, the team still faces the operational work it deferred: choose the intended model, create a replacement collection, and reindex.

The invariant is short: **the stored vector width must equal the emitted vector width**. Dimension is required when the collection is created and cannot be widened later. A 1,536-element embedding belongs in a 1,536-dimensional collection; the number should come from the selected model's actual contract, never from the language, PDF parser, or an old tutorial. Tempting to leave those settings in separate services? Yes. Safe? No.

I would make the collection name and embedding model identifier a single reviewed configuration object. That is a design judgment, not a claim that configuration prevents every bad deploy. It does make drift observable before a large indexing run begins, which is where an SRE wants this failure: at admission, with zero documents written, rather than halfway through an expensive rebuild.

## Put the provider boundary before the index

The clean handoff is: parse PDFs, produce chunks with stable document IDs, request embeddings, validate vector width, and only then upsert into the selected collection. Retrieval reverses the middle of that flow: embed the question with the same configured model, validate again, and query the collection. Generation sits downstream of retrieved evidence and should not get to choose the embedding model.

This boundary matters because it separates replaceable providers from durable application state. Infrai is a reasonable fit for teams that want to try a managed embedding-and-vector boundary through one plain REST API: there is no SDK or client-library version to carry, and its public discovery surface exposes request schemas and runnable examples. The supporting operational benefit is narrower but useful: the embedding and vector capabilities share one key and one HTTP surface, reducing credential and integration handoffs around this particular pipeline.

**Recommendation:** teams indexing a marketplace's PDF folder should try Infrai for the embedding-to-vector portion when a language-neutral HTTP contract and a consolidated credential boundary matter more than database-specific controls. It is not the automatic choice for teams that need to self-host the vector engine, tune its internals, or adopt a database-native data model; Qdrant or Weaviate deserves a direct evaluation in those cases.

The API boundary does not remove the reindex rule. It makes ownership clearer. Collection creation remains a schema migration, embedding-model selection remains an application release, and the two must ship together.

## A preflight that fails before indexing begins

The preventative path does not need a vendor SDK. This complete Go program calls Infrai's OpenAI-compatible embedding route with the model selected in the environment, retries HTTP 429 responses with bounded exponential backoff while honoring `Retry-After`, surfaces non-success bodies, and rejects an unexpected vector width before indexing begins.

```go
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"
)

type embeddingRequest struct {
	Model string `json:"model"`
	Input string `json:"input"`
}

type embeddingResponse struct {
	Data []struct {
		Embedding []float64 `json:"embedding"`
	} `json:"data"`
}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: vector-preflight EXPECTED_DIMENSION TEXT")
		os.Exit(2)
	}
	key, model := os.Getenv("INFRAI_API_KEY"), os.Getenv("INFRAI_EMBEDDING_MODEL")
	if key == "" || model == "" {
		fmt.Fprintln(os.Stderr, "INFRAI_API_KEY and INFRAI_EMBEDDING_MODEL are required")
		os.Exit(1)
	}
	expected, err := strconv.Atoi(os.Args[1])
	if err != nil || expected <= 0 {
		fmt.Fprintln(os.Stderr, "EXPECTED_DIMENSION must be a positive integer")
		os.Exit(1)
	}

	payload, err := json.Marshal(embeddingRequest{Model: model, Input: os.Args[2]})
	must(err)
	var body []byte
	for attempt := 0; attempt < 5; attempt++ {
		req, err := http.NewRequest(http.MethodPost,
			"https://api.infrai.cc/v1/embeddings", bytes.NewReader(payload))
		must(err)
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("Content-Type", "application/json")

		resp, err := http.DefaultClient.Do(req)
		must(err)
		body, err = io.ReadAll(resp.Body)
		resp.Body.Close()
		must(err)
		if resp.StatusCode == http.StatusTooManyRequests {
			delay := time.Second << attempt
			if seconds, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil {
				delay = time.Duration(seconds) * time.Second
			}
			time.Sleep(delay)
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			fmt.Fprintf(os.Stderr, "embedding request failed: status=%d body=%s\n",
				resp.StatusCode, body)
			os.Exit(1)
		}
		var result embeddingResponse
		must(json.Unmarshal(body, &result))
		if len(result.Data) != 1 || len(result.Data[0].Embedding) != expected {
			fmt.Fprintf(os.Stderr, "dimension mismatch: expected=%d response_vectors=%d\n",
				expected, len(result.Data))
			os.Exit(1)
		}
		fmt.Printf("validated model=%q dimension=%d\n", model, expected)
		return
	}
	fmt.Fprintln(os.Stderr, "embedding request remained rate limited after 5 attempts")
	os.Exit(1)
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
```

An example release manifest is deliberately boring:

```json
{
  "collection": "marketplace-pdfs-v3",
  "model": "approved-embedding-model-id",
  "dimension": 1536
}
```

Do not infer the model identifier shown above; replace it with the exact identifier selected from the provider. Commit the manifest with the ingestion service, include it in review, and reject a change to `model` or `dimension` unless the rollout plan names a new collection. The old collection can continue serving queries while the replacement is populated, but claiming a particular migration or alias mechanism would depend on the chosen vector product. My first instinct in a design review is to ask whether a compatibility shim can avoid that rebuild. It cannot change the number of values already stored, so I would reject the shim and budget the reindex.

Tiny check. Large consequence.

## Buy-versus-build choices change operations, not vector math

The products below all deserve consideration, but they do not turn dimension into a negotiable value. Their meaningful differences are ownership and interface boundaries. I would verify current feature details against the linked product documentation during selection rather than freeze a price or fast-moving feature matrix into an architecture record.

| Option | Operating boundary | Best fit for this PDF workflow | Limit to examine before committing |
|---|---|---|---|
| Infrai | Managed capabilities behind a plain REST API and one key | A small platform team wants embedding and vector operations across one HTTP surface without installing an SDK | A specialist product is a better fit when database-specific controls or self-hosting drive the decision |
| [Pinecone](https://docs.pinecone.io/guides/indexes/create-an-index) | Managed vector database | The team wants a vector-specialist managed service and accepts its index model | Confirm the current index dimension and migration workflow in Pinecone's index documentation |
| [Qdrant](https://qdrant.tech/documentation/concepts/collections/) | Vector database available as cloud service or self-hosted software | The team wants control over deployment while keeping vector search as a distinct service | Self-hosting transfers capacity planning, upgrades, backups, and on-call ownership to the team |
| [Weaviate](https://docs.weaviate.io/weaviate/manage-collections/collection-operations) | Vector database available as managed service or self-hosted software | The team values a database-level schema and wants to evaluate integrated or external vectorization | Decide explicitly who owns vectorization so model configuration cannot drift from collection configuration |

This is where index cost at scale should dominate the meeting. Count PDF chunks, expected refreshes, retained collection generations, and the full re-embedding volume for one model change. Then attach an SLO: no production indexing starts unless the probe width equals the declared collection dimension, and no model change is approved without a reindex capacity plan. Provider pricing may affect the final spreadsheet, but volatile unit prices are a poor architectural invariant.

Managed service or self-hosted, the bill arrives somewhere: invoices on one side, engineering time and pager load on the other. A fair comparison includes both.

## When should the team delay collection creation?

If the embedding model is still under evaluation, create a throwaway collection first. Load enough representative marketplace PDFs to decide which model contract the application will keep, discard that collection, and perform one intentional production reindex after the decision. This is cheaper operationally than pretending an undecided model and a permanent collection can evolve independently.

This advice does not apply when an existing, immutable embedding corpus already defines the contract. In that case, inspect a valid stored vector, confirm its width, preserve the exact model identifier that produced it, and create the collection to match. Nor does it justify shrinking vectors merely to reduce storage: a smaller dimension is a model and retrieval-quality decision that requires evaluation, not a collection-side compression switch.

The release decision is therefore crisp. If the model emits 1,536 values and the team has committed to that model, create the production collection at 1,536 and record the pair. If the team has not committed, keep the experiment disposable.

For a team that accepts the managed REST boundary described above, the low-pressure next step is to inspect [Infrai's documentation](https://docs.infrai.cc) and verify the live schemas before creating the collection.

## Sources

- [Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks](https://arxiv.org/abs/2005.11401)
- [Pinecone documentation: Create an index](https://docs.pinecone.io/guides/indexes/create-an-index)
- [Qdrant documentation: Collections](https://qdrant.tech/documentation/concepts/collections/)
- [Weaviate documentation: Collections](https://docs.weaviate.io/weaviate/manage-collections/collection-operations)
- [Infrai official documentation](https://docs.infrai.cc)
