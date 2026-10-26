# Ten-search workflow review — October 26, 2026

The strongest findings are pricing correctness problems: a grade-dependent deal
can have an understated grading fee and a misleading downside, and an ordinary
CGC grade description can incorrectly prevent pricing. Correct these before
increasing search volume. The review changed no production application behavior.

Branch: `search-workflow-review`, based on release `8b0574a`.
Detailed observations: [JSON report](search-review-2026-10-26.json).

## Method and limits

Ran the same ten varied phrases as the October 25 baseline through the actual
server orchestration used by `/api/deals`, with 200 primary results per query,
Any profit/ROI, offers off and automatic discovery. Existing cache lifetimes
were preserved. Only four eligible candidates received full analysis; no forced
AI refreshes were used. Saved actual results were then replayed through the
production UI without provider connections to inspect the sampled deal.

The diagnostic transport guard counted dispatched requests, including retries,
and blocked requests before they could spend allowance. Limits were 150 eBay
Browse and 120 AI requests, 100 price requests, and six NEW discovery photos per
query. The Browse cap prevented the last two primary pages. A supplement fetched
exactly those two pages, increasing the final Browse ceiling to 152, then used
cached-only screening with no further AI/price requests.

Final actual transport counts: **152 Browse, 120 AI, 55 price requests**, plus
20 eBay authentication/analytics requests outside the Browse category. Recorded
AI usage: **272,150 input / 73,638 output tokens**. These are usage counts, not a
dollar-cost estimate. The account-level Browse counter rose from 0 to 190, with
4,810 of 5,000 remaining; the extra 38 cannot be attributed to this process from
the available evidence. Concurrent activity or accounting behavior is unresolved.

Every search had some guard-deferred work. Seven discovery loops returned done
within their sampled budget; that does not mean all photo checks succeeded.
The final three discovery stages were blocked. This is a bounded review, not
an exhaustive ten-search live benchmark. The two supplemental rows cannot
establish normal uncached search quality or timing.

## Timings and candidate counts

A candidate is an optimistic screening lead, not a verified profitable listing.
Eligible excludes long-shot auctions, mismatches and unverified extreme prices.
Times exclude the separately sampled full analyses.

| Phrase | First screened listing | Primary stage | Stream return | Eligible leads |
| --- | ---: | ---: | ---: | ---: |
| 1999 base set holo | 1.05s | 46.76s | 65.61s | 12 |
| neo genesis lugia | 1.26s | 19.11s | 47.16s | 5 |
| pikachu 151 illustration rare | 0.95s | 16.00s | 50.05s | 0 |
| umbreon vmax 215/203 | 0.91s | 17.79s | 42.84s | 5 |
| charizard ex obsidian flames | 0.89s | 39.82s | 69.04s | 2 |
| team rocket dark blastoise | 1.31s | 20.87s | 55.53s | 6 |
| gengar fossil psa 8 | 0.70s | 21.27s | 64.99s | 1 |
| crown zenith mewtwo vstar | 1.74s | 31.59s | 34.18s | 1 |
| pokemon promo swsh050 | Supplemental | Cached screening: 24.39s | Discovery deferred | 0* |
| vintage pokemon holo raw | Supplemental | Cached screening: 0.80s | Discovery deferred | 7* |

*The last two counts reflect capped, cached-only screening. In particular,
193 promo listings remained unscreened after AI was exhausted; that is not
evidence that the normal app cannot understand these listings. Many candidates
in other rows were long-shot auctions: all 12 Pikachu candidates were ineligible
for automatic full analysis, explaining its zero eligible leads.

Early listings arrived quickly with warm title/price caches. Discovery added
roughly 19–44 seconds in the first seven rows even under the diagnostic cap.
The app starts full analyses during normal streaming; this review serialized
selected full evaluations to save resources. Do not read stream-return times
as live UI time-to-first-profitable-card measurements or cold-start guarantees.

## Findings, in recommended order

### 1. Grading tier can be understated when a lower grade sells for more

`shared/money/underwriting.ts:287` chooses the service tier using the resale
value at the highest numerical grade. Actual comp prices need not increase
with grade. The sampled $999 damaged Umbreon had a 1–5 photo range, no likely
grade, low confidence and these PSA scenario prices:

| Grade | Sale estimate | Evidence |
| --- | ---: | --- |
| 1 | $1,739.04 | Returned grade-1 comps |
| 2 | $1,739.04 | Filled from grade 1 |
| 3 | $1,112.50 | Returned grade-3 comps |
| 4 | $1,267.50 | Returned grade-4 comps |
| 5 | $1,395.00 | Returned grade-5 comps |

The app selected its configured Regular tier ($79.99) using $1,395. Its own
configured tier covering $1,739.04 is Express ($175). Using that tier raises
estimated cost by $95.01 and changes estimated profit from **+$45.64 to
−$49.37**. This is an offline counterfactual using the existing configuration,
not verification of current PSA fees or this card's value. The configuration
already labels PSA fees unverified.

Recommended correction: choose a service tier covering the maximum value among
all priced scenarios, with offline tests for nonmonotonic prices and tier caps.
Do not change fees or purchase targets to hide the error.

### 2. Lowest numerical grade is not necessarily the financial downside

`shared/money/underwriting.ts:304` uses the first grade scenario as downside.
For the same Umbreon, the panel said “Still profitable at the low end” and
reported **+$291.70 downside**, while grade 3 in the same table yields
**−$242.81**, even before correcting the fee tier. With that tier corrected,
the lowest modeled outcome is **−$337.82**. A Raichu grading route also showed
this issue, although raw resale remained the selected route there.

Recommended correction: use the minimum modeled net proceeds for financial
downside. Keep “lowest grade” distinct from “lowest return.” Audit missing-grade
fallbacks too: copying a premium grade-1 price into grade 2 is not necessarily
conservative. Do not claim the modeled minimum bounds unobserved losses.

### 3. Normal CGC grade descriptions are treated as special qualifiers

A sampled Lugia CGC 8.5 was sent to NEEDS_REVIEW solely because the photo reader
returned `NM/MINT+` in `gradeQualifier`. `qualifierOf` treats every nonempty
string as a qualifier, and `checkSlab` then refuses pricing. CGC lists
[NM/Mint+ 8.5 on its standard grading scale](https://www.cgccards.uk/card-grading/grading-scale/).

Offline reproduction with the saved photo check: the existing qualifier gives
NEEDS_REVIEW; excluding that ordinary grade description gives OK with the other
checks unchanged. That does not establish that the listing is profitable.

Recommended correction: recognize ordinary grade descriptions by grader and
numeric grade, while preserving rejection of real qualifiers, special tiers,
cracked cases, mismatched certification/grade and authenticity concerns.

### 4. Exact search requirements are incompletely enforced

The Base Set holo results retained explicit non-holo Ivysaur and Pidgey listings.
The Gengar PSA 8 results retained clear PSA 3/5/7 and CGC 8 examples. This is
consistent with `SearchIntent` retaining a graded boolean but no requested grader,
numeric slab grade or finish, and `cardMismatch` checking set/number/printing.
These examples were not all Deals; the issue is irrelevant results and screening
work, not proof of a bad purchase recommendation in each case.

Recommended correction: derive explicit typed grader/grade/finish constraints
locally and enforce clear contradictions early. Preserve uncertain listings for
photo confirmation and maintain separately explained seller-mistake discovery.
Avoid rejecting ambiguous photos merely because no foil reflection is visible.

### 5. Deal quality needs more than passing Any/Any

The four sampled evaluations were:

- Damaged Raichu, $9.99 asking: raw resale estimated +$3.87; marked STRONG.
- Lugia CGC 8.5: held for review because of the ordinary grade description.
- Damaged Umbreon, $999 asking: grading estimated +$45.64 with low confidence;
  appeared under Deals despite the calculation problems above.
- Charizard ex, $29.99 asking: raw resale estimated +$19.89, low photo confidence,
  limited close-ups and negative seller feedback; marked THIN.

Any/Any correctly removes minimum targets; it does not make a $3.87 estimate a
large opportunity or weak photos reliable. After fixing the money math, show
conservative downside prominently and keep low-confidence grade-dependent leads
clearly distinct from stronger raw resale opportunities. A zero eligible result
for a search full of long-shot auctions is often safer than buying at any price.

## Next work

First fix findings 1–3 with saved data and regression tests; none requires more
AI/eBay calls. Then tighten explicit search constraints and the distinction
between evidence quality, target qualification and profit size. Revisit fresh
listing sorting and discovery scheduling only after these correctness issues
are addressed. Do not increase AI volume or remove photo/printing safeguards
just to produce more green cards.

The review itself changed no production behavior. The user later authorized
the priority fixes and delivery of the completed review/corrections to `main`;
see the follow-up below and consult Git for the delivered revision.

## Authorized follow-up

The user subsequently approved the three priority fixes. Their implementation
and offline verification are recorded in
[grading corrections](grading-corrections-2026-10-26.md). The observations above
remain the pre-fix diagnostic record.
