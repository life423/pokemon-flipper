# Deal-search audit and retained findings

This reference preserves the useful findings from the user-supplied *Debugging
Why Pokémon Flipper “Can't Find a Deal”* PDF, coverage patch and code-audit bundle.
The original bundle remains a separate user resource. The PDF and patch were
previously supplied but are no longer available at their original local paths;
their loss must not erase the audit's findings.

The original auditor reviewed source and recorded runs; DNS failure prevented
an independent clone run in that environment. Local browser tests, saved-input
replays and live-market searches are different kinds of evidence. Current flow
and code ownership belong in [architecture.md](architecture.md); open work
belongs in [LOCAL_TODO.md](../LOCAL_TODO.md).

## Central finding

A completed listing stream does not mean that each discovered card received
photo assessment, pricing or a final decision. Missing exact market evidence,
an exhausted allowance, a queue stop and a correct financial exclusion need
different remedies. Explain each listing's last stage and stopping reason before
buying more photo opinions or relaxing identity rules.

The historical Venusaur benchmark retained 50 rows, had sold context for 35 and
automatic eligibility for 33, but completed three raw assessments. The fourth
maximum-cost reservation did not fit its remaining allowance. Expensive raw
listings had ranked before cheaper candidates. A saved replay recovered more
market context and improved ordering; it did not establish a profitable purchase.
See the reproducible requirements in [validation.md](validation.md).

## Original 50-listing Blastoise reconstruction

The original screenshot showed one assessed listing, 49 incomplete and remaining
generation allowance. Its ledger confirmed one PSA 9 reading. A PSA 1 reading
followed later under the same account, but the trigger could not be established.

All 50 positions survived in saved history. A newer search had overwritten the
original source page. Reconstruction used 35 later matching summaries, three
detail records, saved catalog entries and sold pages available at the original
clock. Twelve listings had no recoverable metadata. Providers and image calls
were blocked during replay.

| Reconstructed stopping state | Count | Original positions |
| --- | ---: | --- |
| PSA 9 qualified with exact Unlimited sales | 1 | 1 |
| Price research deferred without a saved usable sale | 26 | 2–4, 8, 16–18, 21–23, 25–32, 34–35, 37, 39, 43, 47–48, 50 |
| One exact sale was below the then-required count | 3 | 10–12 |
| Exact sold market unconfirmed | 8 | 6, 13, 19, 24, 33, 45–46, 49 |
| Metadata unavailable for reconstruction | 12 | 5, 7, 9, 14–15, 20, 36, 38, 40–42, 44 |

This cannot establish which rows actually hit the historical screening allowance.
The source overwrite itself is a reproducibility defect: future reports need
immutable minimal inputs. Current screening can use one eligible matched sale;
do not restore the old three-sale admission requirement from this table.

## Corrections to preserve

- Apply user Buy It Now bounds before eBay selects its source page. A local
  result sort cannot retrieve an excluded or never-fetched listing.
- Do not assign premium-printing profit to a copy whose printing is unresolved.
  The original fixes are recorded in the
  [price-bound commit](https://github.com/life423/pokemon-flipper/commit/e351bdc)
  and [scope-ranking commit](https://github.com/life423/pokemon-flipper/commit/890a3e3).
- Preserve catalog lookup, but reconcile observed set, collector number, holder
  and finish instead of treating the requested query as verified identity.
- Recognized publisher/art/condition residue must not hide an otherwise exact
  market. Keep real unknown words, different printings and genuine conflicts.
- Keep discovery coverage separate from the retained display limit. A promising
  row after unresolved/deferred rows must be reachable, not only one after
  confidently overpriced exclusions.
- Keep absent prices separate from material photo review. Reuse accepted photos
  when evidence is recovered, preserve independent profitable routes and avoid
  paying again for a fact already established.
- Keep a supported loss out of Deals. A useful best checked purchase can be
  shown separately with its actual cost and modeled loss.

These are regression requirements; they are not a claim that every later audit
item remains unfixed. Consult current code, tests and the active checklist before
implementing a proposed correction again.

## Negative and partial findings remain evidence

The recorded Mew ex PSA 9 live sample retained 42 of 49 source rows after initial
screening. Seven assessments produced six priced losses and one identity hold;
the other retained rows lacked confirmed markets. A saved parser replay excluded
more overpriced rows without purchasing photos. Neither result establishes that
all eBay inventory lacks profitable opportunities.

Another saved false-Shadowless case had borrowed a premium market despite a
complete ordinary PSA Base Set label. Reusing its photos and selecting Unlimited
prices corrected the outcome to a loss. Correct label interpretation and exact
prices matter more than manufacturing a positive badge.

A photo-supported First Edition auction reached the normal Deals workflow in a
separate recorded test. It was conditional on winning below the limit; it did
not establish a profitable Buy It Now purchase or realized profit. Early nominal
Deals with unresolved material warnings likewise do not satisfy that milestone.

## Continuing the audit

Use frozen identical inputs to compare before/after behavior, and account for
rejected, unresolved, deferred and never-reached listings. Exercise normal search,
assessment, underwriting and UI grouping with both supported profitable and
genuine losing fixtures. Preserve the original search account, costs and paid
evidence. Unknown storage/accounting state must stop new dispatch.

Only after those checks should a bounded live validation test the current
inventory. A zero-deal live result can be correct; demonstrate why. A successful
fixture proves delivery through the pipeline, while a genuine available card
with supported positive net profit proves the separate live-buying milestone.
