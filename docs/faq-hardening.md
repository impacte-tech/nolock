# FAQ chunking and retrieval hardening

Status: proposed design, not implemented. Branch: `codex/faq-chunking-ranking`.

## Current behavior verified in source

- `src-tauri/src/faq.rs` persists a full question/answer record and embeds only the question. There is no chunking. Exact repeated questions replace the answer and increment frequency; previous answers are not retained as revisions.
- Search embeds the query, fetches `max(10, 4 * topK)` nearest question vectors, and reranks those candidates. Hybrid uses `0.5 * similarity + 0.5 * (frequency / maximum candidate frequency)`. Most-recently-asked breaks ties. Even frequency mode first requires semantic candidates and an embedding request.
- A new exchange is indexed individually. Results are reranked at query time, not stored as a permanent global ranking. A new candidate can change frequency normalization and therefore other candidates' scores.
- The category similarity threshold controls grouping, not retrieval relevance. Reading category lists reconciles automatic assignments; curated assignments remain protected.
- `ChatPanel.tsx` injects complete retrieved Q/A entries, or the README fallback, with no dedicated FAQ token budget.
- Plain text survives an embedding failure, but the UI can still report it as indexed. Changing vector dimensions drops the existing vector table. Embedding identity is not safely separated from the answer-generating model.

## Source preservation and chunking

Keep original question and answer text as the source of truth. Record immutable revisions on edits; store source hashes, entry/revision IDs, field names, chunk order, and exact byte offsets. Chunks and embeddings are derived indexes and can always be rebuilt. Do not use generated summaries as replacements for originals.

Split retrieved knowledge, not the user's live instructions. Keep the current user prompt intact. If a retrieval query exceeds the embedding limit, split it into independent search queries and fuse the results without changing the prompt sent to chat.

Default strategy: structure-aware splitting at Markdown sections, then paragraphs, sentences, and finally token boundaries for oversized blocks. Keep short entries whole. Keep code fences and tables together when they fit; label continuations and preserve offsets when they cannot. Treat the question and answer as separate source fields linked to one parent exchange. Include the question/section context in answer-chunk embeddings, within the embedding token limit; long question context must itself be bounded and explicitly marked as partial.

Suggested starting defaults, subject to evaluation:

| Control | Initial value | User-facing meaning |
| --- | --- | --- |
| Chunk strategy | Structure-aware | Preserve headings and paragraphs where possible |
| Target chunk size | 512 tokens | Balance precise matches with useful context |
| Overlap | 64 tokens | Repeat nearby source text across boundaries |
| Neighbor expansion | 1 chunk on either side | Recover adjacent explanations and constraints |
| Searchable content | Questions and answers | Find facts present only in an answer |
| FAQ context budget | 2,048 tokens | Maximum knowledge injected into a chat request |
| Maximum parent entries | 3 | Avoid filling context with one large entry |

Validate overlap as less than chunk size and cap all embedding payloads to the selected embedding model's supported input limit, including metadata. Use that model's tokenizer where available. Otherwise label counts as estimates and use a conservative configurable limit; do not silently rely on provider truncation.

Overlap cannot guarantee that a model sees every relevant fact. Preserve information in storage, then expose exactly what was retrieved or omitted. Expand neighbors, merge overlapping source ranges, include parent question and section labels, and deduplicate before token budgeting. For short parents, include the whole exchange if it fits. If a block must be clipped, mark it as partial and provide an Open original action. Apply the same budget to README fallback. Account for chat history, system instructions, tools, and reserved output before assigning the effective FAQ budget.

## Ranking policy

Separate candidate retrieval, reranking, and prompt assembly. Retrieve both semantic and lexical candidates so exact identifiers and entries awaiting embeddings can still be found. Fuse candidate lists with reciprocal-rank fusion; expose candidate count as an advanced setting. Never compare raw cosine scores from different embedding generations.

Offer Semantic, Frequency, and Hybrid modes with precise descriptions. Frequency mode searches lexical matches first (or browses the full collection when no query is supplied) and must work without the embedding provider. Hybrid initially weights normalized relevance at 0.8 and popularity at 0.2. Recency is off by default. These are proposed defaults, not measured optima.

Use fixed-scale popularity rather than the maximum of the current candidate set:

`popularity = min(1, log1p(ask_count) / log1p(popularity_saturation))`

Expose popularity saturation (initially 20 asks), relevance/popularity/recency weights summing to one, optional recency half-life, minimum semantic similarity, and maximum results. Specify which timestamp recency uses: the content revision's update time, not mere retrieval. Never increment ask counts for previews, searches, index rebuilds, or category refreshes. Repeated actual questions increment once per exchange using an idempotency key.

Define semantic and lexical relevance normalization in versioned code and tests. A lexical-only result must be labeled as such; a semantic threshold does not pretend to measure lexical confidence. Candidate settings and thresholds need evaluation against the user's embedding model. Defaults must remain adjustable rather than imply calibrated probabilities.

Group chunk matches by parent entry before selecting results. Use the best chunk relevance per parent instead of summing all chunks, so long entries do not win merely by producing more chunks. Use stable entry IDs as the final tie-breaker. Show score components, matched passages, retrieval method, revision, and indexing status in a preview using a sample question.

## Updates and index lifecycle

1. Persist an exchange/revision immediately and mark it pending indexing.
2. Chunk and index only changed revisions; unchanged source hashes reuse embeddings when the embedding generation matches.
3. Publish a complete entry index atomically. Failed work remains retryable and visible as Saved, indexing pending/failed. Never label text-only persistence as successful indexing.
4. Rerank against current committed data on every query. Invalidate preview/result caches on entry revisions, ask-count changes, policy changes, or index generation changes. Unchanged entries do not require re-embedding just because another entry was added.
5. Chunking, searchable-content, tokenizer, or embedding-model changes require a rebuild. Ranking weights, result limits, and context budgets apply on the next retrieval without rebuilding.
6. Build replacements in a separate generation identified by embedding provider/model identity, dimensions, tokenizer, and chunk-policy version. Keep the old compatible generation serving while rebuilding. Query it with its own embedding configuration. If unavailable, fall back to lexical retrieval with an explicit status. Never mix vectors or drop the active generation prematurely.
7. Swap generations atomically only on successful completion. Support cancellation, progress, retry, restart recovery, and disk-space checks. Deleting an entry removes all its derived data; category edits never change source text.

Category grouping remains a distinct control. Separate category representative limits from retrieval top K. Preserve manual categories and names. Make automatic regrouping an explicit refresh or policy-driven background job rather than a hidden side effect of viewing the collection.

## User controls and delivery

Add a Knowledge Base settings surface with Chunking, Retrieval, Context, and Index status sections. Basic controls show strategy, chunk size, overlap, result count, context budget, and ranking mode. Advanced controls expose weights, candidate count, similarity floor, neighbor expansion, and model/tokenizer identity. Show which changes require reindexing before applying them, and let users preview splits and retrieval scores.

Store non-secret project policy in `.faq/config.json` with a schema version. Keep credentials in existing secure provider storage and the SQLite data ignored. Use application defaults when no project file exists; display the effective value and its source. Migrate legacy local settings only through an explicit import, preserving existing behavior until users apply the new policy.

Implement in stages: source revisions and index status; deterministic chunking with previews; safe index generations; query-time ranking and bounded prompt assembly; settings and migration. This document does not enable any of these proposed behaviors yet.

## Acceptance checks

- Removing overlaps reconstructs the exact original Unicode text; no lost ranges or invalid offsets across headings, tables, code blocks, long lines, and empty fields.
- Boundary-dependent facts retrieve with their parent/neighbor context, including facts found only in answers and multi-part questions.
- Embedding and chat budgets hold including wrappers and metadata; omitted text is visible in previews.
- Answer edits, deletion, duplicate delivery, and concurrent updates cannot publish stale chunks or inflate counts.
- Index rebuild failures and model changes preserve searchable originals and the last compatible index; same-dimension model changes are detected too.
- Ranking is deterministic, tunable, and explainable. New entries appear on the next query without re-embedding unrelated entries.
- Provider outages support clearly labeled lexical retrieval and never claim full indexing.
- A small versioned evaluation set checks expected relevant passages, boundary coverage, duplication, and irrelevant-context rate across proposed defaults. User previews permit comparing policies before rebuilding.

## Implemented first step: approval workflow

The branch now implements manual review and approval via the Learning-mode book button; see `faq-review.md` for actual behavior and limits. The broader chunking/ranking defaults above remain proposals. The first step uses lossless paragraph-first character splitting and editable summary excerpts, with no automatic persistence before approval.
