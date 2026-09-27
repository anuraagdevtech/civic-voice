# Privacy model

A platform that records what a billion people think about their government is a
surveillance risk by default. The design assumption is that the operator will eventually be
compelled to hand over what it holds, so the controls aim at **holding as little as possible**
rather than at guarding what is held.

Implementation: `packages/core/src/anonymity.ts`, `packages/core/src/pseudonym.ts`,
`packages/core/src/bands.ts`.

---

## 1. Collect bands, never values

Demographics are stored only as coarse bands, assigned on the client before transmission:

| Dimension | Buckets |
| --- | --- |
| Age | 18–24, 25–34, 35–44, 45–54, 55–64, 65+ |
| Gender | female, male, other/undisclosed |
| Urbanity | urban, rural |
| Income | 5 bands, indexed to per-capita income deciles |
| Education | 5 bands, up to postgraduate |
| Occupation | 8 bands (agriculture, informal labour, salaried private, government, self-employed, student, homemaker, retired/other) |
| Employment status | 4 bands, as PLFS defines them (working regularly, working casually or seasonally, not working and looking, not in the labour force) |

No birth date. No exact income. No employer. **A value never collected cannot leak, be
subpoenaed, or be correlated.** Band assignment is client-side and one-way.

## 2. Per-topic pseudonyms

An event carries a pseudonym alongside the citizen id on the **event log only**, and only the
pseudonym survives into anything long-lived. The distinction is load-bearing and worth stating
precisely rather than overclaiming:

| Store | Retention | Holds `citizen_id`? | Why |
| --- | --- | --- | --- |
| Event log (Kafka) | 7 days, access-controlled | **Yes** | The worker must upsert `sentiment_current` on the citizen's own shard to know whether this replaces an earlier opinion. It cannot route to a shard it cannot identify. |
| ClickHouse, Parquet cold tier | years, broadly queryable | **No** | This is the store an analyst, a researcher, or an attacker with a dump would read. |

`stripIdentity()` is the only way to produce the analytics projection, and `AnalyticsStore.insertEvents`
accepts nothing else — so keeping identity out of the long-lived store is enforced by the type
checker, not by remembering. A pseudonym is then all that store has:

```
pseudonym = HMAC-SHA256(topic_salt[topic_id], citizen_id)   // truncated to 128 bits
```

Per-topic salts (KMS-held, never in the analytics store) mean:

- **Within** a topic, duplicate submissions are detectable — one citizen, one voice.
- **Across** topics, linking a citizen's opinions is not a `JOIN`; it requires every salt.

So an analyst — or an attacker with a full dump of ClickHouse — cannot assemble a political
profile of an individual from the event log. The citizen's own opinion list is reachable only
from their own Postgres shard, encrypted under their own key.

## 3. k-anonymity with complementary suppression

No slice is published unless its cohort is at least **k = 25** (configurable upward per
dimension; the gate never goes below k).

Naive thresholding leaks by subtraction: if a district's total is 1,000 and five of six age
bands are published summing to 985, the suppressed band is 15 — exactly the number that was
meant to be hidden. So the gate applies **complementary suppression**: when a bucket is
suppressed, the next-smallest publishable bucket in the same dimension is suppressed too, and
suppression cascades until the residual cannot be attributed. Totals are rounded to the
nearest 10 above 1,000.

The gate is a single function every read path must pass through, rather than a rule each
endpoint remembers to apply. Tests assert the subtraction attack fails.

**Figures that combine several topics** (opinion against allocation, ADR-0013) cannot be gated on
people: pseudonyms are per topic, so the same person across two topics cannot be counted once — by
design. Instead each topic is gated on its own, only its publishable figures enter the sum, and the
sum is gated again. Every number in a sector figure was therefore publishable by itself, and a group
withheld in every topic is withheld in the sector rather than shown as zero. The same figures'
attention shares, published side by side for every sector, get complementary suppression across the
sectors.

## 4. No raw government identifiers, ever

Verification proves a *property*, then discards the evidence:

1. Citizen verifies via phone OTP or a government-ID verification provider.
2. The provider returns a success assertion. The platform computes
   `blind_index = HMAC(pepper_v, normalised_id)`.
3. **Only the blind index is stored**, in a separate database with separate credentials, and
   only to answer "has this identity already claimed an account?"
4. The raw identifier is zeroed and never written to disk, logs, or traces.

The pepper is KMS-held and versioned; rotation re-blinds rather than re-collects. Aadhaar
numbers are never stored, displayed, logged, or used as a key — consistent with the Aadhaar Act
and the Puttaswamy proportionality standard.

## 5. Erasure — crypto-shredding

Under the DPDP Act 2023 a citizen may withdraw consent and demand erasure. Deleting rows from a
1024-shard cluster with replicas, backups and a 7-day event log is not reliably possible in the
statutory window. So:

- Every citizen's sensitive columns are encrypted under a **per-citizen data-encryption key**,
  wrapped by KMS (`citizen.dek_wrapped`).
- Erasure **destroys the key**. Ciphertext in live rows, replicas, backups and the event log
  becomes unrecoverable at once, including copies the operator cannot reach.
- The row is tombstoned (`erased_at`) so shard integrity and aggregate counts stay consistent.
- **Aggregates are not reversed.** They contain no personal data — they are counts of at least
  25 people — and rewriting history would corrupt the public record. This is stated plainly in
  the consent flow, not buried.

## 6. Data flow boundaries

| Store | May contain | Must never contain |
| --- | --- | --- |
| Catalogue Postgres | Public facts: regions, topics, budgets, disclosures | Anything citizen-linked |
| Sharded Postgres | Pseudonymous citizen rows, encrypted, one shard each | Raw PII |
| `identity_binding` DB | Blind indexes only | Raw identifiers, opinions |
| Event log (7 days) | Bus events, incl. `citizen_id` for shard routing | Raw identifiers |
| ClickHouse | Events with per-topic pseudonyms + bands | `citizen_id`, raw identifiers |
| Redis | Counters, quotas, idempotency | Anything durable or identifying |
| Logs / traces | Ids, request shape | PII, raw identifiers, free-text reasons |

A redaction layer in `packages/observability` strips known-sensitive keys at the logger, so a
careless `log.info({ citizen })` cannot exfiltrate a row.

## 7. Threat model

| Threat | Control |
| --- | --- |
| Full analytics-store dump | Per-topic pseudonyms + bands only — no identity to recover |
| Compelled disclosure of one citizen's politics | Requires their shard **and** their KMS key **and** every topic salt; the operator can hold none of it in one place |
| Re-identification from small slices | k-anonymity gate + complementary suppression + rounding |
| Brigading / Sybil inflation | Verification tiers; default public view counts T2+ only ([TRUST.md](./TRUST.md)) |
| Insider browsing opinions | Sensitive columns encrypted per citizen; DEK access audited; no query path joins identity to events |
| Traffic analysis of *who submitted* | Writes are fixed-size and batched; no per-topic endpoint in the URL path for writes |

## 8. Alignment

- **DPDP Act 2023** — purpose limitation (bands only), consent withdrawal (crypto-shredding),
  data-minimisation by construction, breach-impact reduction via encryption at rest per subject.
- **Puttaswamy (2017)** proportionality — the least data capable of answering "what does this
  district think", and no more.
- **RTI Act 2005 §8(1)(j)** — the platform publishes public-authority information, never
  personal information of filers; the filer's identity is never attached to a published
  disclosure.

## 9. Comments, location and the forum

- **Comments are public; their authors are not.** A comment appears under a handle derived from the
  per-topic pseudonym (§2): stable within a thread, unlinkable across threads. There is no profile
  page, because the only link between one person's threads is their own index (ADR-0008).
- **Personal information is refused before it is accepted** — Aadhaar, PAN, phone numbers, email,
  UPI ids, bank accounts — and the refusal never echoes the match (ADR-0009).
- **The analytics projection of a comment** carries needs, tone and demographic bands, and nothing
  that can be joined back to the comment: no body, no comment id, no pseudonym, time rounded to the
  hour, and keyed hashes for de-duplication and for counting distinct voices. Cohort insights (youth,
  farmers) are k-gated on distinct voices, with complementary suppression of the "everyone else"
  comparison.
- **A location is used once and never kept** — rounded to ~110 m on the device and again on the
  server, sent in a request body, redacted from logs, and discarded after the ward lookup (ADR-0010).
- **Erasure reaches comments.** `DELETE /v1/me` blanks every comment the person wrote, in every
  thread, before tombstoning the account; an interrupted erasure is completed by retrying.
- **The large model is a processor.** When `ANTHROPIC_API_KEY` is set, uncertain comments and digest
  samples — already public, and free of refused personal information — are sent to it (ADR-0011).
