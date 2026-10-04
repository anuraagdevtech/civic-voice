# Trust, verification tiers and Sybil resistance

A public-sentiment platform is only as credible as its resistance to manufactured consent. At
1B users it is a national-scale target for organised brigading, and "one person one voice" is
an engineering problem, not a terms-of-service problem.

Implementation: `packages/core/src/trust.ts`, quota enforcement in `packages/cache`.

---

## 1. Verification tiers

Participation is never blocked, but it is always **labelled**.

| Tier | How it is established | Counted in the default public view? |
| --- | --- | --- |
| **T0 anonymous** | Device attestation (Play Integrity / App Attest) or a proof-of-work token on web | No — shown on a separate axis |
| **T1 phone** | OTP-verified mobile number, blind-indexed for uniqueness | No — shown separately |
| **T2 identity** | Government-ID verification via a provider; one account per blind index | **Yes** |
| **T3 identity + address** | T2 plus an attested home region | Yes, and eligible for region-restricted questions |

Every aggregate is stored and served **per tier**, so the tier used is a property of the number
rather than a footnote. `GET /v1/topics/{id}/mood` returns T2+ by default and carries the
per-tier breakdown alongside, so nobody has to trust our choice of default.

## 2. Why tiers instead of blocking

Requiring government ID to participate would exclude exactly the people a civic platform
exists to hear — and would make the platform a de-facto identity database, which
[PRIVACY.md](./PRIVACY.md) is built to avoid. Requiring nothing makes the numbers meaningless.
Collecting everything and labelling it lets the reader choose, and makes brigading visible
rather than merely denied: a topic whose T0 mood diverges sharply from its T2 mood is a
signal, and the API exposes exactly that as `divergence`.

## 3. Rate limiting and cooldowns

Three independent limits, all evaluated in one Redis pipeline on the write path:

| Limit | Default | Purpose |
| --- | --- | --- |
| Per-citizen token bucket | 60 writes / hour, burst 10 | Bounds a compromised account |
| Per-(citizen, topic) cooldown | 1 change / 10 min | Stops flip-flop amplification |
| Per-IP / ASN budget | tier-scaled, at the edge | Bounds a botnet from one network |

A citizen's standing opinion may be *changed* freely over time — that is the product — but each
change is a compensating delta, so churn cannot inflate a bucket.

## 4. Anomaly detection (asynchronous, never on the hot path)

The worker runs detectors over the event stream and quarantines *aggregates*, not people:

- **Velocity anomaly** — submissions for a (topic, region) far above that region's own
  historical baseline and above its plausible population share.
- **Homogeneity anomaly** — implausibly uniform mood and intensity within a narrow time window
  from one region or one device cohort.
- **Device-cluster anomaly** — many accounts sharing attestation fingerprints or install
  provenance.
- **Population-share violation** — participation in a region exceeding a fraction of its
  census population; a hard, auditable ceiling.

A flagged window is marked `suspect` in the rollup and excluded from the default view, with the
exclusion disclosed in the API response. Detection never silently rewrites the record, and it
never bans an account on an automated signal alone.

## 5. Ballot-box properties we do and do not claim

**We do claim:** one voice per verified identity per topic; no double-counting when an opinion
changes; aggregate integrity auditable by recomputation from the event log; the operator cannot
cheaply link a citizen's opinions across topics.

**We do not claim:** end-to-end verifiability, coercion resistance, or cryptographic receipts.
This is a sentiment platform, not an election system, and overstating it would be the most
harmful thing it could do. The distinction is in the public-facing copy, not only in the docs.
