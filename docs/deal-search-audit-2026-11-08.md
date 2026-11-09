# Deal search audit, November 8, 2026

This checkpoint preserves the findings from the supplied *Debugging Why Pokémon
Flipper “Can't Find a Deal”* audit, the search-coverage patch, and follow-up
tests. The audit's author reviewed source and previously recorded runs. DNS
failure prevented an independent clone run in that environment. The local
browser checks and saved-data replays below are separate evidence.

## What the audit established

- Search ends its listing stream after screening the source page. The browser
  separately queues photo assessments. A completed search can contain priced
  losses, rows waiting on evidence, and rows whose work stopped at a provider
  or spending limit. These outcomes need distinct explanations.
- Exact sold evidence is often the first missing prerequisite. Recent sold
  prices for the exact printing, finish, and slab grade can support price
  screening. For raw cards, sold-title condition remains preliminary. Final
  raw resale needs accepted condition evidence. Preserve these boundaries when
  recovering more comparisons.
- The November 3 Venusaur run retained 50 rows. Thirty-five had sold context and
  33 qualified for automatic assessment. Three completed, and the fourth was
  blocked by the AI reservation. Expensive raw rows had ranked before cheaper
  opportunities. A later saved replay raised sold context from 35 to 42 and
  eligibility from 33 to 39, and prioritized the $64.99 and $69.99 delivered
  candidates. Neither established a verified Deal. [Benchmark](search-cost-benchmark-2026-11-03.md)
  [Candidate selection](candidate-selection-2026-11-03.md)
- The supplied coverage patch's two fixes are already on main. Buy It Now price
  bounds reach eBay before the first page is selected, and unresolved slab
  printings no longer inherit a premium printing's profit for ranking.
  [Coverage commit](https://github.com/life423/pokemon-flipper/commit/e351bdc)
  [Scope-aware ranking commit](https://github.com/life423/pokemon-flipper/commit/890a3e3)
- The local API expects loopback, a matching origin when supplied, and the
  `X-Pokemon-Flipper: 1` header. A 403 at that boundary is a setup issue.
  Successful searches showing Sorting rows have passed the boundary. The server
  defaults to port 3017. The tracked environment template still describes port
  3000 and omits some supported settings.

## Original 50-listing Blastoise reconstruction

The November 3 screenshot of `1999 base set blastoise` showed 50 retained, one
assessed, 49 incomplete, and 1.707¢ left from a 2¢ AI ceiling. The ledger
confirms a PSA 9 assessment costing 0.29256¢. A PSA 1 generation costing
0.27304¢ followed six minutes later under the same search account. Its trigger
could not be established.

All 50 positions were identified in saved history. A later search overwrote the
original source page. The reconstruction used 35 matching summaries from the
newer page, three detail records, saved catalog records, and sold pages available
as of the original search clock. Twelve listings lacked recoverable metadata.
The replay blocked provider and image calls, so its deferred count describes the
reconstruction and cannot identify which rows hit the historical eight-request
screening allowance.

| Reconstructed result | Count | Positions in saved order |
| --- | ---: | --- |
| PSA 9 qualified with nine exact Unlimited sales | 1 | 1 |
| Price research deferred without a usable saved sale | 26 | 2–4, 8, 16–18, 21–23, 25–32, 34–35, 37, 39, 43, 47–48, 50 |
| One exact sale fell below the historical three-sale requirement | 3 | 10–12 |
| Exact sold market could not be established | 8 | 6, 13, 19, 24, 33, 45–46, 49 |
| Listing metadata unavailable | 12 | 5, 7, 9, 14–15, 20, 36, 38, 40–42, 44 |

The current screening policy can use one applicable sale. A separate saved
Blastoise batch showed that title notes such as `NM CLEAN` and `with Sub Grades`
prevented otherwise exact matches. Anchored cleanup raised eligibility from
34 to 36 of 50. Twelve were deferred with new lookups disabled and two still
lacked a confirmed market. This replay used zero provider calls.

## Browser and live validation

- The search page now reports a reason for each skipped retained listing and
  separates listings loaded from assessments completed. Source rows excluded
  before reaching the grid are represented by aggregate counts.
- A mocked browser search exercised the real browser queue and underwriting.
  The fixture with $51.34 modeled profit reached Deals. The fixture with a
  $300.47 modeled loss stayed out. A third row showed its sold-price blocker and
  made no assessment request. This was verified at desktop and mobile widths.
  The browser responses were mocked. A checked-in provider-mocked test through
  the HTTP stream and evaluation endpoints remains useful.
- Live `Mew ex Paldean Fates 232/091 PSA 9` at Any/Any returned 49 source rows.
  Forty-eight were screened, six were excluded above target, and 42 were
  retained. Seven completed assessments, with six priced losses and one
  identity hold. The other 35 lacked a confirmed market. Deals stayed at zero.
  The run used 1.15278¢ of AI for one text and seven slab-label requests,
  eight eBay Browse requests, and 14 PKMNPrices requests reporting 23 credits.
- Replaying those source rows after fixing release-anchored `SV`, `SIR`, and
  `FA` parsing excluded 34 above target, up from six, using exact recent PSA 9
  sales already available. Three of the 14 remaining rows qualified for photos
  with useful but incomplete market scope. Eleven still needed exact identity,
  including eight `Bubble Mew`, two `Special Illustration`, and one
  `Contender` title. Four of those 11 previously inherited the query name.
  Replay used zero provider calls.
- The targeted stamp follow-up uses one crop at native resolution and requires
  current verified terms plus two exact pricing outcomes that change the
  decision. The saved Espeon gate check kept the original uncertain stamp and
  issued zero crop calls because it lacked the required comparison. A mocked
  evaluator test covers a crop that changes the verdict and survives repricing.
  Short query assistance and the listing-text tie-break share the existing
  search budget. The tie-break can reorder eligible candidates with seller
  disclosures. Its effect on paid photo count still needs measurement.
- An exact Base Set Charizard CGC 7.5 live search retained zero rows from ten
  reported results and spent no AI. The earlier controlled First Edition Dark
  Raichu run stopped after two completed assessments out of 24 retained rows.
  Its captured budget included a pending charge and its zero Deals count
  describes a deliberately partial run.

## Remaining work from the audit

The [active checklist](../LOCAL_TODO.md) records the remaining fixes. Preserve a
small diagnostic record under each original search UUID with the frozen clock,
settings and version, per-listing terminal stage and reason, source and retained
counts, sold statuses, queue admissions and completions, pricing retries,
verdicts, provider status, and remaining budgets. Link it to versioned minimal
inputs in private storage so a later cache overwrite cannot prevent replay.
Keep raw provider responses, photos, credentials and user data out of Git.

The next pricing recovery path should reuse accepted photo evidence and allow a
small number of requests under the original price ledger. It needs a clear
terminal reason when the missing evidence cannot be recovered. Measure the
remaining exact-market misses and price-only cases before another paid batch.
A verified live, positive-margin Buy It Now listing reaching Deals remains the
open milestone.
