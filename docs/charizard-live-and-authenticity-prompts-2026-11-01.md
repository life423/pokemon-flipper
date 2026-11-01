# Charizard live test and authenticity prompt correction — November 1, 2026

## Completed baseline

Baseline revision: main 1e7af1e3c3abe07f18ec7bac9ec45cacaad020e6. Query:
**1999 charizard**, interpreted as **1999 charizard base set**. The actual browser
run started at 18:22:54 UTC and was observed complete by 18:57:59 UTC, approximately
35 minutes. Settings: 400 results, All matching full AI analyses, $50 minimum
profit, 25% ROI, Best Offers off, no minimum price or potential grade.

The final visible result inventory was **479 listings, 7 Deals, 0 Waiting,
92 Review, 37 Hidden finds and 20 Long shots**. These are overlapping views, not
partition counts. Clearing only the financial targets produced **22 Deals** at
Any profit / Any ROI; restoring $50/25% returned seven. This was repricing in the
browser, not another search. All 479 retained listings showed completed photo
reviews and zero screened-only results. There were 498 completed evaluation
attempts; excluded/expired/nonmatching items explain why that differs from 479.

The primary eBay search reported 3,861 matches; the primary pass screened 380,
and discovery checked 881 additional photo candidates across eight searches,
for 1,261 checks. That is not 1,261 fully assessed matching cards.

All 92 visible Review cards were matched uniquely to saved evaluations by image
identity and listing price. Primary blocking reasons:

| Reason | Listings |
| --- | ---: |
| Printing/edition conflict | 21 |
| Insufficient usable photos | 3 |
| Card identity/release/number conflict | 18 |
| Raw authenticity concern | 30 |
| Slab certificate conflict | 6 |
| Slab grade/label gap | 4 |
| Missing accepted pricing evidence | 5 |
| Slab qualifier | 4 |
| Cracked slab case | 1 |
| **Total** | **92** |

Thirty had authenticity as their primary blocking reason. Some cite only lack
of authentication detail or photographic limitations; others mention a visible
feature requiring careful comparison. Do not assume all thirty are false flags.
Two additional identity-conflict items also carried authenticity flags.

## BGS and TAG

BGS and TAG reached full AI evaluation; no PSA/CGC-only grader rejection remained.
The completed BGS 9 report used ten matching BGS 9 sold comps, $2,515 median,
$1,559 item limit and passed at $3,650 asking. BGS auctions could qualify as
long-shot opportunities without a new raw grading fee.

- TAG 6.5, item 147653329913: label/printing read successfully. No accepted exact
  grade sold evidence; its current-listing search returned only the subject.
- TAG 7.5, item 336712306149: certificate in item specifics disagrees with label.
- BGS 4, item 227584598605: no accepted exact-grade sold/current comparison.
- Other BGS holds involve printing conflicts, not unsupported grading companies.

Certificate conflicts here are AI label versus item-specific comparisons, not
claims of external certificate verification or proof of fraud.

## Changes prompted by the live evidence

The old raw-condition prompt asked AI to flag printing/font/stock differences,
but offered no structured distinction between a visible anomaly and missing
photographic proof. The more-cautious selector prioritized any POSSIBLE answer
before grade/wear, and selected the original answer rather than its normalized
version. A generic caution could override a more useful condition assessment.

The correction keeps the current models and existing request concurrency:

- Stable trusted Responses instructions, separated from quoted seller data.
- Contrasting examples covering glare, holders, wear, overlays, normal evolution
  text, actual visible manufacturing anomalies and different releases.
- Required photo-numbered observations with the observed feature, expected
  comparison and judgment: suspicious, photo limitation, normal feature,
  condition damage or identity difference. Empty observations are valid.
- A release/printing difference alone is handled by identity checks, not called
  counterfeit manufacture. Genuine diagnostic anomalies still block advice.
- Unsupported alerts or invalid photo references retry instead of being silently
  cleared. Legacy unstructured warnings remain intact until reassessed.
- Normalize both condition opinions before selecting the cautious one. Limited
  photos still retain null likely grades and Low confidence.
- A separate raw-condition prompt revision refreshes this stage without clearing
  paid identity/photo work, historical sold-condition categories, or price data.

Official OpenAI guidance informed the separation of trusted instructions and
examples: [Prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering).
Structured outputs enforce shape, while factual errors still require application
validation and evaluations: [Structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
Photo limitations and small-text errors remain relevant:
[Images and vision](https://developers.openai.com/api/docs/guides/images-vision).

## Real before/after checks

Four previously authenticity-held raw listings were reevaluated with paid APIs:

| eBay item | New result | Condition evidence |
| --- | --- | --- |
| 206591058514 | PASS at $899.95 | Moderately Played; likely grade still unknown |
| 327411703143 | PASS at $499.99 | Heavily Played; likely grade 3 |
| 206659966875 | PASS at $899.99 | Near Mint; likely grade still unknown |
| 278299056047 | PASS at $365 | Moderately Played; likely grade 4 |

All four reported no specific suspicious authenticity observation; they reused
their original photo checks and requested two new condition opinions each.
They did not become profitable just because the authenticity hold resolved.
The $365 UI case used a $325 matched raw sold median and calculated a $131.18
loss after acquisition/sale costs, with a $193 limit at $50/25% targets.

The different-printing control, item 206666289400, was also tested. See the
final control result: NEEDS_REVIEW for its title/item-specific
identity conflict, with NONE_SEEN and an explicit IDENTITY_DIFFERENCE observation after refinement. A first prompt pass
overstated a different release as fake manufacture; the final instruction example
explicitly separates those concepts, and only that isolated condition checkpoint
was invalidated for retesting. Earlier paid findings remain saved for comparison.

These are targeted checks; the entire 479-listing search was not rerun with the
new prompt. The baseline 7/92 counts cannot be claimed as post-fix counts.

## Remaining issues and follow-up priorities

1. **Align Deals with evidence quality.** All seven baseline Deals still show
   Your review needed; five have no likely grade. Several use uniform scenario
   weights across a broad grade range. Other warnings merely repeat ordinary
   photo limitations. Separate incidental notes from material missing evidence
   and align underwriting/ranking with the displayed uncertainty before treating
   nominal Deals as seven strong purchase recommendations.
2. **Resolve actual identity rather than stopping at seller conflicts.** Twenty-one
   primary holds concern printing/edition disagreements, including apparent raw
   Shadowless upgrades. Test an independent identity adjudication and repricing
   workflow; do not override a readable ordinary PSA label with border guesses.
3. **Move analysis submission to server jobs.** The browser queues long POSTs over
   plain HTTP/1.1. Chromium's normal per-host connection pool defaults to six;
   the UI's 100 analyzing jobs does not measure 100 simultaneous provider calls.
   Actual provider concurrency was not measured. Test a server-owned bulk job and
   one event stream, preserving eBay daily reservations.
   [Chromium socket-pool source](https://chromium.googlesource.com/chromium/src/+/refs/tags/145.0.7572.5/net/socket/client_socket_pool_manager.cc).

## Verification and isolation

Baseline API telemetry: 2,316 calls, 20,645,609 input and 1,938,061 output tokens.
One 90-second connection failure was retried; no exhausted-credit event occurred.
These are recorded usage figures, not an invoice or a dollar-cost estimate.
eBay daily protection remained active; baseline completion showed 4,637/5,000
remaining. Existing provider caches were copied into isolated data; the user's
shortlist SHA256 remained A10AC88C9F78630EBC7F569F289BB6823ACECC6D8E99F32A758303DF07A734B5.

Browser checks covered 320/390/768/1440 widths plus landscape for the baseline
TAG report; responsive report layout, no observed horizontal overflow, 44px close
targets, modal focus containment and Escape dismissal. Updated real raw report
was inspected on phone and desktop. These are viewport tests, not physical-device
or complete accessibility/performance certification. No eBay bids/offers/messages
were submitted. Initial IAB localhost navigation failed; Chrome was used.

Internal UI review heuristics: usability 7/10, hierarchy 8/10, accessibility 8/10,
consistency 7/10, responsiveness 8/10, feedback 7/10, performance 5/10. The concrete
P1 recommendations are evidence-aligned Deals/review feedback and shorter server
job completion; P2 is making seller conflicts self-resolving when independent
identity evidence permits. These are review heuristics, not measured scores or
a reason for an unrelated redesign.

Local evidence and raw API results remain ignored under data/reviews and the
temporary pokemon-charizard-live-2026-11-01 artifact folder. No secrets or raw
responses are included in this report. Normal app port is 3017; 3000 is another
application and was left alone. The unrelated .env.example deletion stays out
of this change.

Final checks: 456 tests pass, both TypeScript projects pass, production build and
Git diff formatting pass. New asset is index-DPmpXtxb.js. The final condition
prompt revision is 2; photo revision remains 10 and pricing remains resale-8.

The isolated prompt checks recorded 43 successful AI calls: 12 condition requests
(including the two-opinion control refinement), 28 historical sold-condition
reviews needed by pricing, and three comparable checks. No photo-check requests
were repeated. The main 3017 app was restarted and visibly loaded the new asset
with the existing three-item shortlist. Isolated 3026/3027 servers were stopped.
