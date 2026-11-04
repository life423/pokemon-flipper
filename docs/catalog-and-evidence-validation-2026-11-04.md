# Catalog, sold evidence and model validation

This checkpoint fixes avoidable catalog and sold-data losses, prevents unsupported
reference prices from creating Deals, and compares a cheaper slab reader. It
did not switch production models or raise any spending allowance. A subsequent
user-authorized marketplace/data-request increase is described below; the
OpenAI dollar ceiling remains unchanged.

## Changes

1. Catalog queries, list admission, detail admission and sold-title matching use
   the same conservative card-name rules. Known finish/art descriptors can be
   removed; owners, apostrophes, forms, set and number remain meaningful. Positive
   old apostrophe-query cache entries remain reusable without letting an old
   empty malformed query hide a corrected lookup.
2. Preliminary sold research can follow up to four pages for a market with
   fewer than three eligible observations. It stops when sufficient observations
   are available, deduplicates and preserves partial evidence when deferred.
   Screening and final valuation use the same cached page URLs. Existing 32
   screening-session and 64 original-search request safeguards remain in place.
3. Explicit TCGplayer raw quotes and asking-only slab references retain labeled
   scenario estimates. They cannot create a final Deal or completed rejection.
   A separately supported route can still qualify. A price-only gap stays in
   Sorting; a real material photo concern can still need attention. Unknown
   downside stays unknown, including for older saved BUY or NEEDS_REVIEW records.
4. Cards and detail sections no longer present reference-only prices as actionable
   profit, offer or bid recommendations. Pricing gaps do not suggest purchasing
   another full photo assessment. Slabs omit the irrelevant raw-condition field.
5. Measured diagnostics can resume an original report under its existing query,
   search UUID and allowances. Saved-only replay still blocks all transports.

## Retesting the corrected flow

The four affected searches continued their original allowances. New search IDs,
ledger resets and forced photo reassessment were not used.

| Search | Result | New generation cost |
| --- | --- | ---: |
| Snorlax Jungle holo | Six assessments; zero Deals | 1.17496 cents |
| Leafeon V alternate art PSA 9 | Six assessments, all priced passes; zero Deals | 0.97820 cents |
| Blaine's Arcanine holo | Seven assessments; the next reservation was correctly blocked | 1.70280 cents |
| Dragonite Fossil Unlimited PSA 8 | Three accepted assessments reused; no new generation | 0 cents |
| Total | Nineteen new assessments | **3.85596 cents** |

These retests used 24 Browse requests and 41 PKMNPrices requests reporting 345
credits. Each original search retained its two-cent generation ceiling. The
remaining allowance can be insufficient for the next maximum input/output
reservation even when settled spending is below the ceiling.

A subsequent cache-only Dragonite replay recovered four eligible Unlimited PSA 8
sales and seven of eight market contexts. Three overpriced rows were excluded
before photo assessment. Importantly, all four sales were already on the first
page: known publisher/artist title text caused the earlier admission loss.
This corrects the initial pagination diagnosis. Sparse-page recovery is a
separate improvement covered by controlled pagination tests. This replay made
zero provider requests and left local usage/allowance files unchanged.

A strict Entei replay reused all five accepted assessments. The earlier thin
TCGplayer-based BUY now remains an unconfirmed reference in Sorting, with no
invented downside or Deal recommendation. It made zero provider requests.

**No profitable opportunity supported by matched sold evidence was established
in these retests.** Recovering data and removing a false positive do not prove
that current inventory contains a suitable purchase.

## Cheaper slab-reader comparison

Six manually inspected English PSA 8 slabs covered Fossil Dragonite, Neo Genesis
Typhlosion and Neo Revelation Suicune, including First Edition controls. Each
candidate request used the original search's remaining allowance and separate
diagnostic storage. Accepted production assessments were preserved.

| Same six controls | Settled generation cost |
| --- | ---: |
| Historical GPT-5.6 Luna assessments | 1.01916 cents |
| GPT-6 Luna comparison | 0.47737 cents |
| Measured reduction | **53.16%** |

All six core label transcriptions matched. Three stamp-presence fields abstained
rather than asserting an absent stamp; existing label interpretation nevertheless
resolved all six exact identities, printings and pricing routes without new
review reasons. These were not perfect matches across every raw output field.

The paired requests had identical reported input-token counts. Historical inline
image bytes were not retained, so byte-identical historical inputs cannot be
proven. This small PSA-only extension does not validate every grader, qualifier,
half-grade, poor photograph or raw-card condition task. These are label-reading
checks, not physical authenticity certification or profitable-Deal validation.

The comparison made six generations and six exact-input preflights, with zero
Browse or PKMNPrices requests. Twelve known-CDN source photos were downloaded
once during preparation. Strict replay reused all six diagnostic answers and
made no provider, image or preflight request. Production defaults are unchanged.

Combined additional generation spending for the four retests and six comparisons
was **4.33333 cents**, distributed across the original searches. It is not one
search's cost. No individual allowance was increased.

## Text-only prioritization experiment

The current pipeline already normalizes metadata, removes clear mismatches,
loads shared sold evidence, computes profit in code and ranks candidates before
buying photos. An unconditional text-model pass would repeat much of that work.

A compact diagnostic now tests a text-only ordering using source facts and sold
summaries already available. GPT-6 Luna supports `reasoning.effort: "none"`; bounded photo and
comparison requests already use it. Keep output to candidate IDs and source-linked
reasons. Do not let text ranking invent condition, prices, authenticity or a
Deal. Save the exact snapshot result and share the original generation allowance.
Judge the experiment by useful photo selections, missed candidates, latency and
total cost against the existing free order before enabling a new paid stage.
[Official model documentation](https://developers.openai.com/api/docs/models/gpt-6-luna).

Standard rates are $0.10 input and $0.50 output per million tokens. Flex and Batch
are $0.05/$0.25. For illustration only, 5,000 input plus 500 output tokens would
cost $0.00075 (0.075 cents) at Standard rates, before any applicable cache-write
or other charges. Actual preflight and settled usage govern the allowance.
[Official pricing](https://developers.openai.com/api/docs/pricing).

Several candidates can share one ordinary request without using the Batch API.
Standard processing suits time-sensitive new listings. Batch's 24-hour completion
window suits background evaluations or backfills; Flex trades latency and
availability for cost. Neither is currently enabled in the app's Standard-only
spending guard. Adding either requires tier-aware reservation, reconciliation,
cancellation and duplicate protection before dispatch; a failed request must
not silently trigger a second, more expensive opinion.
[Batch guide](https://developers.openai.com/api/docs/guides/batch),
[Flex guide](https://developers.openai.com/api/docs/guides/flex-processing).

Deprecated or retiring models are excluded from selection. No deprecated Nano
model was invoked. Broader model rollout and any text-ranking stage remain
explicitly separate from this completed cleanup.

One saved Blaine's Arcanine search supplied 50 original metadata rows. Existing
filters first reduced those to 30 photo-eligible candidates. The request shared
nine distinct sold-market summaries and omitted all photographs and later
assessment answers. One Standard GPT-6 Luna request, with reasoning disabled,
used 7,956 input and 125 output tokens. It settled at **$0.0008581 (0.08581 cents)**,
with zero reasoning tokens, no unresolved hold and no marketplace/data-provider
requests. Provider generation took about 2.3 seconds, plus a 0.9-second preflight.
The original search remained below two cents including its previous work.

Six of its eight suggested candidates overlapped the existing first eight.
Six suggested candidates had historical outcomes: one PASS, four CANT_PRICE
and one NEEDS_REVIEW. Two were unassessed. The experiment therefore establishes
that grouped text ranking is inexpensive; it does **not** yet establish a better
order, reduced total cost or fewer missed Deals. No photo request was actually
avoided because this was a diagnostic, and prior photo costs were already spent.
The next useful comparison needs broader known outcomes and a defined queue or
defer policy. Omitted candidates must remain reachable; scarce budget can make
a poor ranking an effective exclusion.

The accepted text answer is saved separately using its immutable metadata,
model and request fingerprint. Strict replay reused it with zero generation,
preflight, image, Browse or PKMNPrices requests. Use
`scripts/compare-listing-priority.ts --live --report <original-report.json>`
or `--replay --report <original-report.json>` explicitly. This diagnostic accepts
Buy It Now snapshots only; auction eligibility needs a frozen-clock extension.
No new search account is created. It cannot change production queue order or
overwrite photo findings.

## Subsequent provider allowance and warning update

The user authorized more useful provider research, with alerts for fast daily
consumption. New searches now allow 50 eBay Browse requests, 64 preliminary
PKMNPrices requests and 128 total PKMNPrices requests. Existing stored 25-Browse
and 64-price accounts retain their limits, attempts and unknown charges; no
counter is reset. These are app request safeguards, distinct from eBay's daily
provider quota and the PKMNPrices monthly plan's daily credits. The two-cent
OpenAI generation cap is unchanged.

A visible warning appears at 20% or less daily allowance remaining, or after
at least 5% of the provider allowance is observed consumed within fifteen
minutes. Account-hashed local samples persist across searches/restarts and
expire when stale or reset. Observations come from existing eBay reconciliation
and reservation events and durable PKMN response headers. Additional UI polling
reads local state only. No new provider requests or model calls were needed to
implement or test this update. A monitoring failure cannot invalidate accepted
data or authorize replacement work.

## Validation

All 927 offline tests pass under both default and explicit GPT-6 Luna slab
configuration. Both typechecks, the production build and whitespace checks pass.
A deterministic test-completion barrier fixed a mocked rate-limit test race;
production retry/cooldown behavior did not change. The local app responds on
port 3017. Git records the delivery checkpoint; private plans and provider
payloads remain ignored.
