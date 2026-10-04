# RTI tracking

The Right to Information Act, 2005 gives every citizen a statutory clock against a public
authority. Most requests fail not because the information is exempt but because the filer does
not know the deadline passed or that an appeal is free and time-bounded. Modelling the clock
correctly is most of the product value.

Implementation: `packages/core/src/rti.ts` (pure functions, exhaustively tested).

---

## 1. Statutory clock

| Stage | Statutory limit | Source |
| --- | --- | --- |
| PIO response | **30 days** from receipt | §7(1) |
| Life or liberty of a person | **48 hours** | §7(1) proviso |
| Request routed to another authority (§6(3)) | 30 days **+ 5 days** transfer allowance | §6(3) + §7(1) |
| Third-party representation involved | **40 days** | §11(1)–(3) |
| Deemed refusal | Expiry of the above with no response | §7(2) |
| First appeal (filing window) | **30 days** from response or deemed refusal | §19(1) |
| First Appellate Authority decision | **30 days**, extendable to **45** with reasons | §19(6) |
| Second appeal to CIC/SIC | **90 days** from FAA decision or its expiry | §19(3) |

`rtiDeadlines()` returns every one of these dates for a request, and `nextAction()` returns
what the citizen can do today and how long they have left. Both are pure functions over the
request's state, so they are cheap to call and safe to test exhaustively — including the case
that matters most: **deemed refusal is itself an appealable event**, so a silent authority does
not stall the ladder.

## 2. State machine

```
draft → filed → acknowledged ─┬─▶ responded ──┬─▶ satisfied → closed
                              │               └─▶ first_appeal ─┬─▶ fa_responded ─┬─▶ closed
                              └─▶ deemed_refused ───────────────┘                 └─▶ second_appeal → sic_responded → closed
                                                                                        │
                                                          (any state) ──▶ withdrawn ─────┘
```

Transitions are validated by `canTransition()`; illegal transitions are rejected at the API
boundary rather than trusted from the client. `deemed_refused` is reached by the worker's
deadline sweeper, not by a user action — the platform notices on the citizen's behalf, which is
the entire point.

## 3. Deadline sweeper

The worker scans for requests crossing a statutory boundary and, for each:

1. Advances state where the statute does so automatically (`filed` → `deemed_refused`).
2. Notifies the filer with the concrete next step, the deadline, and a pre-filled appeal draft
   addressed to the correct First Appellate Authority (from `authority.faa_contact`).
3. Updates the authority's public **compliance scorecard**.

The scan is sharded and time-bucketed, so it is a bounded amount of work per shard per hour
rather than a full-table scan of 50M requests.

## 4. Authority compliance scorecard

Per authority, rolling 12 months, published:

- response rate within the statutory window
- median actual response days
- deemed-refusal rate
- first-appeal rate, and the rate at which appeals overturn the original refusal
- §8 exemptions cited, by clause

This turns a private frustration into a public, comparable metric — and, crucially, it is
computed from the same rollup machinery as sentiment, so it inherits the same caching and scale
properties.

## 5. Disclosure pipeline — RTI as evidence

A response, once received, can be published by the filer:

1. Upload → content-addressed by `sha256` (so the same document filed by many citizens is one
   object).
2. Text extraction + OCR for scanned replies; indexed for search.
3. **Filer identity is detached**: a `disclosure` row links to the authority and topic, never to
   the `rti_request` or the citizen. §8(1)(j) cuts both ways.
4. Crowd verification: other citizens confirm the document matches its claimed source.
5. Linked to `budget_line` / `utilisation` rows where it evidences a monetary figure.

This is the join that makes the platform more than a mood ring: *this* is what the district
thinks about the scheme, *this* is what the government said it spent, and *this* is the
document we got by asking.

## 6. What the platform does not do

It does not file RTIs on a citizen's behalf, pay the ₹10 fee, or act as an intermediary with
the PIO — doing so would make the platform the applicant and break the citizen's standing under
the Act. It tracks, reminds, drafts, and publishes. The filing is the citizen's own.
