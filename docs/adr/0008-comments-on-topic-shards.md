# 0008 — Comments live on their topic's shard, and go through the log like opinions

**Status:** Accepted

## Context
Opinions are small and closed (a mood, an intensity, a reason code); comments are free text,
arbitrarily many per person per topic, and read as a thread. ADR-0001 shards by citizen because every
opinion query is "this citizen's rows". Every comment query is the opposite: "this topic's thread".
Storing comments with their authors would make reading one thread a scatter-gather across up to 1,024
shards — exactly what ADR-0007 forbids.

## Decision
- A comment is stored on the shard that owns `vshardForTopic(topic_id)` — FNV-1a over the topic id,
  the same hash family as citizens — together with its votes, reports and the topic's digest. A
  thread, however read, is one shard. The author's own index (`my_comment`) lives on **their**
  shard, which serves "my comments" and erasure.
- The router gains `withTopicShard` / `withTopicTransaction`. Still no cross-shard API: an operation
  that touches both (insert, delete, erase) runs as two single-shard steps ordered so that a crash
  between them is repaired by retrying — comment first then index on insert (a redelivery fills the
  gap), blank every comment then drop the index on erasure (a retry finds them again).
- The API does only what must be synchronous — authentication, "do you live here", rate limits,
  refusing personal information — and appends a `civic.comment.v1` event, keyed by topic. The worker
  moderates, labels, stores, projects to analytics and bumps trending. Same commit point as opinions
  (ADR-0003); a comment appears within seconds rather than on the request.
- Authors appear under a per-topic handle derived from the per-topic pseudonym: stable within a
  thread, unlinkable across threads.
- The analytics projection of a comment has no body, no comment id, no pseudonym and hour-coarsened
  time; `dedupe_key` and `author_key` are keyed hashes. A cohort is k-gated on distinct voices, not
  comments.

## Consequences
- Thread reads, votes and reports are single-shard, whatever the fleet size.
- The comment path's cost is dominated by the worker's analysis (measured 0.68 ms per comment), and
  the capacity model covers it (`computeForumCapacity`, docs/SCALING.md §11).

## What we gave up
- **A hot topic is one shard.** Every comment on a national controversy lands on one Postgres
  primary. At the modelled spike that is ~7k comments/s across *all* topics, so even a topic taking
  all of it is within one primary's write capacity with batching — but it is a hot spot by design.
  Reads are absorbed by the edge (a 15 s TTL collapses a thread's first page to a few origin
  requests per POP per TTL).
- **No profile pages.** There is no way to show "everything this person has said" to anyone but
  them, because the only link between their threads is their own index. That is intended.
- **"Top" pagination is approximate.** It pages on upvotes, which move while you read; a comment can
  appear twice or be skipped across pages. The client de-duplicates.
- **Write-then-see is not instant.** The author sees "posting…" until the worker publishes.
