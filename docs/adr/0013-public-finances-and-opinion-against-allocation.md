# 0013 — Show the gap as the budget does, and gate every topic before combining opinion

**Status:** Accepted

## Context
The project overview asks for three things the platform did not do: show how much each government
collects in each tax (income tax, GST, customs, corporation tax, excise, other levies) and spends in
each sector (infrastructure, health, education, defence, rural development, subsidies and welfare);
show the gap between the two; and let a researcher set public sentiment against budget allocation,
sector by sector. It also adds employment status to the demographics.

`budget_line` tracks scheme utilisation — allocated, released, spent — which answers "where did the
money for this scheme go in my district", not "what does this government collect and spend". And
nothing tied a topic, or a comment, to a spending head.

Each part has a way to mislead. A "gap" can be drawn so it looks like waste, or quietly fold every
unreconciled rupee into borrowing. A sentiment-against-spending chart invites a causal reading. And
opinion summed across topics has no honest privacy gate: pseudonyms are per topic (ADR-0005's
companion in PRIVACY.md §2), so the same person across two topics cannot be counted once.

## Decision
- **One catalogue table for a government's accounts:** `fiscal_line`, one published figure per
  (government, financial year, stage, category), in ₹ crore, with source and provenance. The
  government is a region — the country for the Union, a state for itself. The stage (budget
  estimate, revised estimate, audited actual) is part of the key, because the same year's figure
  differs by stage and must never be shown without it.
- **A closed vocabulary**, in contracts: nine tax categories, five other receipts (non-tax revenue,
  non-debt capital, the share of Union taxes and grants a state receives, borrowing), and sixteen
  spending sectors — twelve programmes and four committed or pass-through heads (interest, pensions,
  transfers to states and to local bodies). A figure that does not fit is mapped by a person in the
  reviewed load file, not guessed by a parser.
- **The gap is drawn as Budget at a Glance draws it**: where each rupee spent came from. Taxes paid
  for 66 paise of it; the other 34 came from borrowing, other receipts or the Union. Taxes are gross
  for the Union, with the states' share shown as spending passed on; a state's share of Union taxes
  is money from the Union, not its own tax. When no borrowing figure is published, or receipts and
  spending differ by more than 2%, the shortfall is shown as a shortfall and the loader warns —
  never assigned to borrowing because that makes the chart balance.
- **Topics carry a sector** (programme sectors only; nobody has a topic "about" interest). Ingested
  documents and raised issues are classified from the same need lexicon the comment model uses, so a
  topic about drinking water and a comment asking for it land on the same head; null when nothing
  fits, because an unclassified topic is better than a wrong one.
- **Opinion against allocation** puts three figures side by side per sector, for one government:
  its share of programme spending; its share of what residents raise (comment needs mapped to heads,
  the mapping published); and residents' mood on *that government's own* decisions in the sector.
- **Privacy, by the one gate.** Attention is gated on distinct voices per sector, with complementary
  suppression *across sectors*, since the shares are published together. Mood is gated **per topic
  first**, and only publishable topic figures are summed; the sums pass the gate again, and a group
  withheld in every topic is withheld in the sector rather than shown as zero.
- **Scale by construction:** three reads whatever the catalogue size — the government's budget lines
  and at most 2,000 of its newest sector topics, one comment scan with a group of aggregates per
  sector, one rollup scan over all those topics (`AnalyticsStore.topicSlices`). Edge-cached for 15
  minutes; CSV for spreadsheets.
- **Employment status** (PLFS categories) becomes the seventh demographic dimension, appended so
  every stored ordinal and the rollup dimension index are unchanged.

## Consequences
- The capacity model re-derived itself: 32 counters per event instead of 28, ~5.6M counter
  touches/s at the spike, ~17% of the Redis fleet. The pinned tests failed until every published
  figure was updated — which is what they are for.
- Every figure on the Money tab has a year, a stage and a source; development samples are badged.
- Researchers get figures they can cite, with the method stated in the response itself, and cells
  that were withheld arrive empty in the CSV rather than as zeros.

## What we gave up
- **No automatic budget ingestion.** Budget documents are PDFs and spreadsheets, once or twice a
  year, with heads that shift between years; a person maps them to the vocabulary. That is a few
  hours a year per government, and it is the difference between a figure and a guess.
- **Mood by sector undercounts small groups.** A group's figure counts only the topics where that
  group was large enough to publish. This is the price of combining opinion without being able to
  count people across topics, and the response says so.
- **Only a government's own decisions count toward its mood.** A state's residents' views on Union
  schemes are in the Union's figures, not the state's. This keeps "opinion on decisions" and "the
  spending that funds them" about the same government.
- **Associations, not causes.** A sector can be raised often because it is visible and well funded,
  or because it is neither. The product states this beside the chart rather than hoping nobody
  draws the wrong line.
