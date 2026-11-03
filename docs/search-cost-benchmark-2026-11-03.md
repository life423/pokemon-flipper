# Bounded search cost and outcome benchmark — November 3, 2026

## Result

One exact-card Buy It Now search loaded 50 metadata listings and completed three
new raw photo assessments in 58.271 seconds. Recorded AI charges were
**$0.0140084 (1.40084 cents)**, with no unresolved holds. The two-cent reservation
guard denied a fourth generation. No confirmed Deal resulted: one assessed card
was a priced Pass and two retained printing uncertainty.

This validates bounded spending and reuse in this sample. It does **not**
establish an efficient deal-finding workflow, accurate photo judgments across
the market, or a cost per successful deal. Increasing the cap is not the next
optimization justified by this result.

## Method and scope

- Query: `Venusaur Base Set 15/102 Unlimited holo`.
- Buy It Now, both raw and graded, Any profit/ROI, offers off, English-only.
- Actual `searchWithDiscovery` bounded path and `createBoundedEvaluator` with
  normal Azure SQL caches and the existing persistent AI/Browse guards.
- One UUID throughout screening and every assessment. No forced refresh,
  legacy broad discovery, deeper review or automatic diagnostic retry.
- Client admission, priority and feedback rules reproduced with two assessment
  slots. Assessments started after metadata screening, so timings are not an
  exact browser interaction benchmark. Initial set-year, shortlist and other
  UI bootstrap requests are excluded.
- An additional diagnostic ceiling of 16 total uncached PKMNPrices requests
  covered all stages. It was not reached. This does not implement a production
  all-stage price budget: the production eight-request allowance still applies
  to preliminary screening only.

Private raw reports and provider observations are under ignored
`data/search-benchmarks/`. The live operation ID is
`dbeed952-208b-4f07-ae2a-390878f657e1`; no credentials, authorization headers or
request bodies are included in the diagnostic transport log.

## Coverage and outcomes

| Stage | Observed result |
| --- | --- |
| eBay reported inventory | 577 results |
| Source page | 200 listings |
| Admitted metadata | 50: 39 raw, 11 graded |
| Sold evidence available | 35 listings |
| Sold research deferred | 15, all reporting the preliminary eight-request allowance |
| Preliminary slab rejections | 2, requiring no new photo assessment |
| Eligible for automatic assessment | 33 |
| Assessments admitted | 4: three returned, fourth denied before generation |
| Eligible rows never admitted | 29 after the search-wide budget stop |
| Final assessed outcomes | 1 Pass, 2 Needs attention, 0 Deals |
| Final UI grouping | 50 All matching, 45 Sorting, 2 Needs attention, 0 Deals |

The remaining 47 rows did not receive full photo assessment. Two of those were
finished preliminary rejections. The other 45 were unfinished sorting work;
they were not failed photo verifications. Metadata finished at 21.837 seconds.
Both raw and graded metadata were present, but **all three newly assessed cards
were raw**; this run does not benchmark new slab-label assessments.

One raw Pass used the explicitly labeled TCGplayer market fallback. Its final
raw pricing had zero sold copies with accepted saved photo-condition evidence,
despite preliminary sold-title context. This is not a verified condition-matched
eBay sold-price decision. The two printing uncertainties are recorded model
outputs, not independently established photo defects or proof that a stronger
model is necessary.

## Provider accounting

| Resource | Actual dispatched work |
| --- | --- |
| AI generations | 3, existing `gpt-5.6-luna`, 18 supplied photos |
| Exact input-token preflights | 4, reported separately from generation |
| Generation usage | 52,072 input and 2,995 output tokens; zero cached/write tokens reported |
| AI settled charge | $0.0140084; 3 settled reservations, $0 unresolved |
| AI budget remaining | $0.0059916 (0.59916 cents) |
| eBay Browse | 5: primary search and four listing details |
| eBay Analytics / OAuth | 2 / 1; separate from Browse |
| PKMNPrices | 9 requests: 8 screening, 1 final valuation |
| PKMNPrices reported credits | 76, every response reported `x-credits-charged` |
| eBay image downloads | 24; separate from Browse and AI generations |

The fourth input preflight reported 20,239 input tokens. Reserving that request
with the raw route's 2,200-token output ceiling requires up to $0.00769975 at
the existing conservative rates. That exceeds the final $0.0059916 remaining,
even after the other accepted work settles. The guard behaved as designed;
this was not an arbitrary three-card limit. Six photos were downloaded for the
denied candidate before input preflight, so not every downloaded photo was sent
to a generation.

Actual Browse transports and the persistent per-search reservation count both
equaled five. The reconciled account snapshot went from 35/5,000 to 40/5,000 used
(4,960 remaining at completion). Account totals can also reflect other app
activity and should not replace per-operation transport accounting.

No duplicate dispatched Browse/PKMNPrices request hashes appeared within this
sample. This does not prove every different query represents distinct necessary
research. About 74% of the recorded AI charge came from input tokens, which
includes prompts, schema and images; the diagnostic does not apportion exact
input tokens between those components.

Credits are provider-reported units, not dollars. Response credit balances were
not monotonic, so the sum of explicit charged-credit fields is reported without
claiming a reconciled account balance or subscription cash cost. AI totals use
reported usage and configured verified rates, not a new provider billing export.

## Saved-evidence replay

Replayed only the three completed assessments against the saved metadata using
the **same original search UUID**. All new paid/provider data transports were
blocked, and a missing assessment would fail before AI preflight/reservation.

- Same outcomes; one saved private evaluation and two shared photo answers reused.
- Zero new AI generations, preflights, Browse, price requests or image downloads.
- Zero additional settled charges, reservations or holds.

This demonstrates useful reuse for these results. It is not a fresh eBay
availability check, or proof that all 50 rows could finish from the cache.

## Follow-up priorities

1. A single understandable per-search price-data accounting boundary across
   catalog lookup, screening, final raw/slab valuation and retries, with shared
   SQL reuse and explicit request/row/credit totals. The current screening-only
   allowance and missing durable all-stage telemetry are saved in the private
   roadmap; they were not refactored during measurement.
2. Evaluate raw candidate ordering and selective photo work against these saved
   cases. The admitted raw rows tied at priority band 0/evidence 2, with no
   expected profit or investment estimate from the unspecified-condition sold
   context. Ordering therefore fell through to photo support and ID tie-breaks,
   rather than estimated deal economics. Every new raw generation received six
   photos and all three returned no supported numeric grade. The admitted LP
   asking prices were $150.48 plus $38.49 shipping, $164.99 with free shipping,
   and $104.99 plus $1.29. Lower-priced rows remained waiting. This does not
   prove the photos could never reveal grading upside, but it exposes a weak
   allocation of the available research budget. Avoid another whole-card
   assessment when a focused missing fact and existing observations suffice. Test accuracy and
   total useful outcomes before changing models or output limits.
   Canonical catalog identity also needs attention: twelve of the fifteen
   deferred rows carried names contaminated with descriptors such as
   `venusaur light play`, `venusaur ex-mt` and `venusaur swirl`, causing separate
   exact catalog queries. Cleanly named CGC markets were also deferred, so
   normalizing names will not replace missing market research. Preserve real
   card-name/variant words when removing condition or marketing noise.
3. Align preliminary sold-title context and final photo-conditioned raw pricing
   explanations, preserving their different evidence strength. Missing exact
   condition data must not be silently treated as confirmed eBay resale value.
   A separate cheap parser defect was reproduced offline: the HP-stat removal
   regex consumes `102 HP` in `Venusaur 15/102 HP Holo…`, removing a heavily
   played condition claim. The saved $44.14 sale consequently remains in the
   unspecified bucket. One corrected observation alone still cannot establish
   a reliable condition median. This defect is recorded for follow-up, not fixed
   by the diagnostic.
4. Retain the separate deferred progress/early-stop and photo visibility/language
   investigations. This benchmark does not repair or establish the cause of
   the earlier Blastoise screenshot.

## Verification and organization

The diagnostic entrypoint is `scripts/bounded-search-benchmark.ts`. Its helpers
separate queue reproduction, result grouping and sanitized transport accounting
under `scripts/review/`; offline regressions are in `test/review/`.

The production workflow, model choices and limits are unchanged. Three existing
client type-only imports gained explicit TypeScript suffixes so the diagnostic
can use the actual UI result grouping without copying it. Full offline suite:
**837 passing tests**; both typechecks, production build and whitespace checks
passed. No commit, merge or push was performed.
