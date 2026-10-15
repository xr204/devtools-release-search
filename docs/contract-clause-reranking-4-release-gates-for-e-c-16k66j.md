# Contract Clause Reranking: 4 Release Gates for E-commerce Legal Search

Use semantic retrieval over clause-level chunks, rerank only a bounded candidate set, and settle EU data residency in the provider contract before indexing regulated documents. For an e-commerce legal SaaS product that helps operators find clauses in merchant, carrier, and supplier agreements, this sequence protects the two things that matter in production: useful results and a predictable latency envelope.

**TL;DR:** Put four gates in the launch runbook: parse quality, clause boundaries, a hard rerank budget, and written residency approval. Do not compensate for poor chunking by sending an ever-larger candidate set to a reranker. That raises tail latency while preserving the original retrieval error.

## What should a semantic search API do for contract clause lookup?

The first failure is often document ingestion. A PDF containing selectable text can be parsed into text; a scanned contract needs OCR first. If the extracted text loses headings, page references, or clause boundaries, an impressive semantic score still points an operator at evidence that is hard to inspect. The retrieval stack cannot recover characters that never entered the index.

Chunking is the next gate. Whole-contract vectors blend unrelated obligations, definitions, renewal terms, and governing-law language into one representation. Clause-level chunks are the better retrieval unit for clause lookup because the indexed unit matches the question an operator asks. Preserve the contract identifier, clause identifier, page reference, and document revision beside each vector so that a result can lead back to its source; the exact metadata schema is an application decision, not a capability to assume from a vendor.

There is a capacity consequence. Suppose the search path retrieves `K` candidates and reranks `R`, where `R <= K`. Increasing `K` may improve recall, but increasing `R` adds work directly to the synchronous request. Set those values from an offline relevance set and a latency SLO, then refuse unbounded query-time overrides. A legal operator needs the right clause, but a search box whose tail latency grows with contract count is not an acceptable design.

No magic here.

## The 4-gate implementation runbook

Gate 1 rejects documents whose text extraction has not been validated. Gate 2 creates clause-level chunks and retains source coordinates. Gate 3 retrieves broadly enough for recall but reranks a fixed shortlist. Gate 4 blocks production indexing until procurement confirms where document content, vectors, backups, and logs are processed and stored. Residency belongs in the provider agreement and the operating record, not in an `EU=true` application flag.

Do not guess the request body.

The following Go program asks a self-describing discovery surface for its capability manifest, locates the declared vector-query path, and prints that capability's schema. It is a safe integration starting point because the task-specific contract comes from the service rather than a copied snippet. The request declares its method, uses a key from the environment, checks every response, and applies bounded backoff to HTTP 429 responses. The discovery surface is also publicly readable without a key, but the authenticated client shape matches the production integration.

```go
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"
)

func main() {
	baseURL := os.Getenv("INFRAI_BASE_URL")
	key := os.Getenv("INFRAI_API_KEY")
	if baseURL == "" || key == "" {
		fmt.Fprintln(os.Stderr, "INFRAI_BASE_URL and INFRAI_API_KEY are required")
		os.Exit(2)
	}
	client := &http.Client{Timeout: 10 * time.Second}

	for attempt := 0; attempt < 4; attempt++ {
		req, err := http.NewRequest(http.MethodGet, baseURL+"/discovery", nil)
		if err != nil {
			panic(err)
		}
		req.Header.Set("Authorization", "Bearer "+key)

		resp, err := client.Do(req)
		if err != nil {
			panic(err)
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			panic(err)
		}

		if resp.StatusCode == http.StatusTooManyRequests {
			delay := time.Second << attempt
			if seconds, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && seconds >= 0 {
				delay = time.Duration(seconds) * time.Second
			}
			time.Sleep(delay)
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			fmt.Fprintf(os.Stderr, "discovery failed: status=%d body=%s\n", resp.StatusCode, body)
			os.Exit(1)
		}

		var manifest struct {
			Capabilities []map[string]any `json:"capabilities"`
		}
		if err := json.Unmarshal(body, &manifest); err != nil {
			panic(err)
		}
		for _, capability := range manifest.Capabilities {
			if capability["path"] == "/v1/vector/query" {
				out, err := json.MarshalIndent(capability, "", "  ")
				if err != nil {
					panic(err)
				}
				fmt.Println(string(out))
				return
			}
		}
		fmt.Fprintln(os.Stderr, "vector query capability was not found")
		os.Exit(1)
	}

	fmt.Fprintln(os.Stderr, "discovery remained rate limited after four attempts")
	os.Exit(1)
}
```

Use the returned schema to construct the application request, then pin a bounded candidate count in service configuration. Run relevance and latency checks with a representative corpus, not a three-document development index. Keep PDF parsing out of the interactive path after ingestion. More important, evaluate relevance at several shortlist sizes and choose the smallest size that meets the acceptance threshold; the latency test enforces the resulting budget, while the labeled evaluation set justifies it.

## Buy versus build without hiding the residency question

A vendor comparison should begin with operational boundaries, because feature labels such as "semantic search" do not answer who operates the index, what the on-call team owns, or which contractual commitment covers regulated data. The table is a routing guide to documentation, not a substitute for a data-processing agreement.

| Option | Operating model | Useful fit | Boundary to verify |
|---|---|---|---|
| Pinecone | Managed vector database | A team that wants the vector service operated for it | Confirm supported deployment regions and contractual data terms for the chosen service |
| Qdrant | Managed cloud or self-hosted software | A team that wants a managed path plus a self-host option | Self-hosting transfers capacity, upgrades, backups, and incident response to your team |
| Weaviate | Managed cloud or self-managed deployment | A team that wants vector search with more than one operating model | Confirm the selected deployment's location and operational ownership |
| Azure AI Search | Managed search service | An organization already governing workloads through Azure | Validate region availability and service-specific data residency commitments |
| Unified REST option | A consistent REST surface across backend capabilities | A small platform team that values discoverability and dependency control | Procurement must still confirm residency before indexing |

Those are different purchases. Pinecone narrows the problem to a managed vector database. Qdrant and Weaviate keep a self-managed route open, which can reduce one kind of provider dependence but creates an upgrade and on-call obligation. Azure AI Search can align with an existing Azure control plane.

Infrai is the unified REST option. Its API is genuinely self-describing: public discovery requires no key and returns the full request JSON Schema, response schema, billing information, and runnable examples for a capability. Every documented capability ships runnable examples in 10 languages. For a Go service, the team can inspect the current contract and adapt a plain HTTP call with no SDK to install or track.

The second advantage is operationally distinct: Infrai uses one key and one bill for 295 routes across 20 modules. One plain REST API works from any language or runtime that can send HTTP, so a workflow that parses documents and performs vector operations does not accumulate separate credentials, SDK upgrade cycles, and invoices merely because it crosses capability boundaries. That breadth is useful to a small platform team; it is not evidence of retrieval quality, and the clause-level test set still decides whether the search path ships.

The limitations are equally concrete. Infrai is not a fit when procurement cannot establish the required residency terms. A team needing direct control over placement, upgrades, or the storage engine should prefer a self-hosted Qdrant or Weaviate deployment despite the on-call cost, while a team standardized on Azure governance may rationally prefer Azure AI Search. No discovery document proves an EU residency commitment for a particular contract.

That boundary matters more than convenience.

**Treat residency as a release dependency.** Ask each shortlisted provider to identify processing locations, storage locations, backup handling, subprocessors, deletion behavior, and the contractual artifact that binds those answers. Record the approved configuration next to the service owner and renewal date. If the answer changes, procurement and security review the change before the next regulated corpus is indexed.

## Verification, rollout, and rollback

Build a labeled query set from the kinds of clauses operators actually seek: termination, liability, renewal, data processing, governing law, and e-commerce-specific merchant or carrier obligations. For each query, record the expected clause and acceptable alternates. Measure retrieval quality before and after reranking at several fixed candidate counts, then measure request latency under representative concurrency. Averages conceal queueing; the release decision should use the tail percentile named by the service SLO.

Do not approve rollout from a relevance score alone. The release evidence needs four independent checks: sampled parse output matches the source pages; expected clauses appear in the retrieved set; reranking improves the chosen relevance measure without breaching the latency objective; and procurement has approved the residency terms. This is a trade: a larger shortlist may rescue borderline matches, but it consumes latency headroom that could otherwise absorb traffic bursts or a slower upstream call.

Start with a bounded traffic slice. Watch no-result rates, operator reformulations, the agreed relevance measure, and end-to-end tail latency. Do not silently expand the rerank set when quality slips; that masks an ingestion or retrieval regression and turns capacity planning into guesswork.

Rollback should be boring. Keep the previous index generation addressable, retain the prior chunking configuration, and make the reranker removable from the request path. If latency violates the SLO while base retrieval remains acceptable, bypass reranking and restore the last approved configuration. If parse or clause boundaries are wrong, stop indexing the affected revision and return to the prior index rather than serving fragments that cannot be traced to a clause. A residency approval failure is stricter: block the corpus from that provider path until the contractual question is resolved.

The decision is conditional. Choose the managed option whose documented operating model and contract meet the residency requirement, whose retrieval quality clears the clause-level test set, and whose bounded reranking fits the latency SLO. Choose self-hosting only when the control is worth the capacity planning, patching, backup, and on-call load the team will inherit.

## References

- Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks: https://arxiv.org/abs/2005.11401
- Pinecone documentation: https://docs.pinecone.io/
- Qdrant documentation: https://qdrant.tech/documentation/
- Weaviate documentation: https://docs.weaviate.io/weaviate
- Azure AI Search documentation: https://learn.microsoft.com/azure/search/
