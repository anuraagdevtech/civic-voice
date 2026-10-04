# 0005 — Label participation by tier; never block it

**Status:** Accepted

## Context
Two failure modes bracket the design. Require government ID to participate, and the platform
excludes exactly the people it exists to hear — while becoming a de-facto national identity
database, which is the thing PRIVACY.md is built to avoid. Require nothing, and organised
brigading makes every number meaningless.

## Decision
Four verification tiers (T0 anonymous → T3 ID + attested address). Everyone may participate.
Every aggregate is stored and served **per tier**. The default public view counts T2+; lower
tiers are published alongside, labelled, on a separate axis.

## Consequences
- The tier is a property of the number, not a footnote, so nobody has to trust our default.
- Brigading becomes *visible* rather than merely denied: T0-vs-T2 `divergence` is an exposed
  field and a useful signal in itself.
- Anonymous participation stays possible for people who cannot or will not verify.

## What we gave up
Roughly 4× the rollup storage (one set per tier), and a harder story to explain than a single
headline number. We take the explanation cost over publishing a number we cannot defend.
