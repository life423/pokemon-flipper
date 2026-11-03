# Candidate selection follow-up — November 3, 2026

Checkpoint `24f0da1` committed the preceding audit, bounded research and
benchmark work. This follow-up is on `improve/deal-candidate-selection`.

## Changes

**Reuse canonical card research.** Seller descriptions such as Light Play,
Swirl and grader-context EX-MT no longer become separate exact card-name
queries. The resolver compares whole names, retains unknown residual words,
and preserves printed names/forms such as Dark, Light, Alolan, Mega, ex, EX,
V, VMAX, VSTAR, owners and gender. Set and collector-number conflicts remain
unresolved. It does not coerce a listing into the searched card or invalidate
paid title/photo answers.

**Order unpriced raw prospects using relevant market context.** Within existing
financial priority band zero, an ordinary raw listing with known shipping and
at least two distinct photos can be ordered by delivered asking divided by the
recent unspecified-condition sold median. Context must come from one exact
card/record/printing/finish scope with at least three usable recent sales.
Known conflicting claims, foreign listings, mixed markets, stale/future facts
and missing shipping do not gain this boost.

The ratio is research ordering, not expected profit, a resale estimate, a safe
bid, or a grade. Existing supported financial bands keep their previous
ordering. Suspicious asks below twenty percent of the comparison median and
explicit heavy-play/damage claims do not gain the ordinary-prospect boost.
They remain inspectable; raw asking prices above the median remain eligible
for possible grading upside. CGC and PSA paths are retained independently.

**Parse seller condition consistently.** A shared pure parser now handles raw
sold-title and literal listing claims. `15/102 HP`, `HP15/102`, and `#123 HP`
retain the heavily-played claim; actual `120 HP`/`HP120` statistics do not imply
damage. Questioned or conflicting conditions remain unknown. Title-only
Excellent and Mint display mappings remain compatible. Seller condition still
does not establish photographed condition.

## Saved-data validation

Reused the original fifty-row Venusaur benchmark metadata and normal SQL
provider-page caches. The real `priceFirstListings`/sold-screening functions ran
with `maxRequests: 0` and data-provider transports blocked. No source pages or
listing availability were refreshed, and no paid photo assessments were run.

| Measure | Original snapshot | Saved-only replay |
| --- | --- | --- |
| Loaded metadata | 50 | 50 |
| Sold-price context available | 35 | 42 |
| Price research deferred | 15 | 8 |
| Eligible for automatic assessment | 33 | 39 |
| New provider calls during replay | — | 0 |

All twelve description-contaminated names resolve cleanly in the pure name
replay. Seven additional rows recovered usable sold context from existing
pages; canonical naming alone cannot create missing grader/grade sales.

The first ordinary raw prospects after replay were $64.99 and $69.99 delivered.
The original paid batch began with $150.48 plus $38.49 shipping and $164.99 with
free shipping. This is better research allocation, not a demonstration that
either newly prioritized card is profitable. No new verified Deal is claimed.

The shared condition parser also moves a previously misparsed $44.14 HP sale
out of the unspecified bucket. Consequently that bucket's median changes from
$69.815 to $71 from the **same cached transactions**; this is not market growth
or a new price fetch.

Private replay details are kept beside the original ignored benchmark report
as `candidate-selection-saved-replay.json`. Existing two-cent AI, twenty-five
Browse-per-search and daily quota protections are unchanged. The production
all-stage price-data budget remains separate future work.

## Organization and verification

- `server/identity/screening-name.ts`: conservative research-name resolution.
- `shared/raw-condition-claim.ts`: reusable seller-condition parser.
- `shared/sold-evidence.ts`: extracted shared sold-reference contract.
- `shared/raw-market-context.ts`: research-only raw context.
- Existing screening and queue modules consume these helpers; no duplicate
  provider workflow or new background worker was added.

All **859 offline tests**, server/client typechecks, production build and
whitespace checks pass. Tests cover modern/vintage names, preserved forms,
catalog/page reuse, shipping, condition ambiguity, graded-path priorities,
single/mixed scopes, sparse/stale/invalid facts, nonmutation and stable ordering.
The current follow-up does not implement grading turnaround/holding-time
estimates, repair deferred photo-identification cases, or prove deal discovery.
