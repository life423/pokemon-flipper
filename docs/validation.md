# Validation and measured work

Use this guide to evaluate a change without repeating costly searches or calling
an increased assessment count a successful deal-finding result. The
[architecture](architecture.md), [money model](money-calculations.md) and
[active checklist](../LOCAL_TODO.md) describe the current implementation and work.

## Exercise the normal workflow

1. Resolve the search and catalog criteria without treating requested identity
   as physical evidence. Keep format, edition, finish, language and slab grade.
2. Fetch the bounded source window under the existing account; deduplicate IDs
   and record every rejected, unresolved, deferred and never-reached row.
3. Apply sold-price screening and prioritization. Preserve unresolved work beyond
   the display limit and explain all admission decisions.
4. Reuse accepted findings before assessing only decision-relevant photos.
   Current price/shipping/availability can refresh without repurchasing photos.
5. Calculate supported routes using the real money engine and current settings.
6. Exercise the normal client queue and result selectors. Verify the actual card
   reaches Deals, Projected losses, Sorting or review for the expected reason.

An isolated arithmetic test, crop answer or injected verdict does not prove this
sequence works. A completed source stream does not prove assessment completion.

## Freeze inputs before comparing changes

Store minimal versioned inputs privately: source/retained IDs and order, raw
claims, accepted image bytes or content fingerprints, relevant sold evidence,
clock, destination, money settings, filters/targets, assessment/pricing versions,
original search UUID and starting accounting. Cache reads must not rewrite source
timestamps. Never put credentials, raw provider responses or paid photos in Git.

Replay the same inputs and settings before/after. Disable all provider transports
and fail on a missing saved input. A cache-only miss means incomplete replay,
not permission to replace the observation or open a new spending account.

Required representative cases:

- A promising listing after 50 unresolved/deferred rows, separately from one
  after confidently overpriced exclusions.
- Base Set Blastoise 2/102 versus genuine Base Set 2 2/130; also reprints,
  finish/printing differences and custom protective cases.
- Metadata/photo conflicts, unreadable identity, actual material damage and a
  supported correction of inaccurate seller specifics.
- A genuine loss, a supported profitable fixture, unknown shipping, stale/ended
  terms and a separate Best current buy comparison with negative resale math.
- Missing price recovery after accepted photos, including optional raw sold-photo
  work stopping without suppressing an independent supported grading route.

## Explain counts and costs

Report source rows, unique IDs, eligibility exclusions by reason, screened rows,
retained rows, unresolved overflow, never-reached rows, queue admissions, completed
assessments and final classifications. Result views can overlap; do not sum their
counts as a partition. Report supported profitable opportunities, not only work.

Keep resource measures distinct: actual eBay Browse requests, OAuth/Analytics,
PKMNPrices requests and header-reported credits, image downloads, exact-input
preflights, generation usage, settled dollars and unresolved holds. Provider
daily usage can include other work and is not a per-operation counter.

Verify identical replay dispatches zero replacement research and adds zero
charge. Accepted negative findings, source corrections and unavailable historical
pages must remain reusable. Cancellation blocks later dispatch while accepted
responses finish saving. Inject storage/ledger failures and confirm fail-closed
behavior; a timeout or quota handler cannot hide corrupt accounting.

Use existing authorization and account limits for live checks. Choose one bounded
question, inspect current shipping/availability, stop when answered and report
remaining uncertainty. This guide itself does not authorize a fresh live batch.

## Retained measurements

The earlier 50-row Venusaur benchmark completed three new raw assessments for
$0.0140084. The next maximum-cost reservation exceeded the remaining allowance;
there was no arbitrary three-card rule. It found zero verified Deals. Saved
replay added no provider work. This is one finite sample under its recorded
settings, not a current cap, raw/slab accuracy benchmark or cost per successful
deal. Its private inputs remain under `data/search-benchmarks/`.

Saved model diagnostics established these narrow results:

| Sample | Observed result | New generation cost |
| --- | --- | ---: |
| Three PSA 7 label controls | Core card/holder/grade/cert fields matched | $0.0018122 |
| Two manually selected stamp regions | Visible positive and empty region matched inspection | $0.0024200 |
| Six PSA 8 controls | Core label fields matched; three stamp fields abstained | $0.0047737 |
| Six PSA 5/CGC 9 controls | Core fields matched after existing normalization | $0.0047467 |

Strict saved replay reused these answers without new generation, preflight,
images, Browse or pricing calls. These checks did not authenticate certificates,
calibrate raw grading or prove profitable purchases. Historical image bytes were
not frozen for every baseline, so historical cost comparisons are not controlled
simultaneous byte-identical A/B trials. Diagnostic answers stayed separate from
accepted production evidence.

One grouped text-priority diagnostic cost $0.0008581 and shared six of its first
eight choices with the free ordering. It avoided no actual photo call. Cheap
text ranking alone therefore did not establish improved decisions or lower total
cost. Retain deferred candidates so a poor ranking does not silently exclude them.

## Model and interface evaluation

Before changing a model or prompt, use varied saved controls: multiple graders,
half-grades, qualifiers, reprints, difficult views, raw/slab categorization errors
and seller/photo conflicts. Freeze exact request inputs, compare raw output and
normalized decisions separately, and measure corrections, missed opportunities,
latency and total cost. Never run both models automatically for every listing.

Check [saved-model tooling](../scripts/compare-saved-models.ts),
[text-priority tooling](../scripts/compare-listing-priority.ts) and the
[normal-flow benchmark](../scripts/bounded-search-benchmark.ts) before creating
another evaluator. Preserve accepted keys, original account sponsorship and
unknown-charge protection. Verify support and retirement status before choosing
a new model; old saved answers can remain compatible without authorizing new use.

Primary implementation references: [vision](https://developers.openai.com/api/docs/guides/images-vision),
[structured output](https://developers.openai.com/api/docs/guides/structured-outputs),
[prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering),
[pricing](https://developers.openai.com/api/docs/pricing),
[Batch](https://developers.openai.com/api/docs/guides/batch),
[Flex](https://developers.openai.com/api/docs/guides/flex-processing),
and recorded model references for [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna),
[GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) and
[GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra).
Batch/Flex require tier-aware accounting, cancellation and duplicate protection.

For the interface, verify narrow phone, tablet and desktop layouts, zoomed text,
keyboard focus/return/Escape, touch targets, original-image inspection, scrolling,
load failures and reduced motion. Reuse the
[supplied portfolio effects](https://github.com/life423/drewclark.io-portfolio/blob/main/app/src/styles/plugins/animations.js)
only where they clarify an action. Browser checks and automated accessibility
scans do not establish physical-device coverage, complete accessibility or market
accuracy. Browser concurrency is also distinct from actual provider concurrency;
the [Chromium connection-pool source](https://chromium.googlesource.com/chromium/src/+/refs/tags/145.0.7572.5/net/socket/client_socket_pool_manager.cc)
was the original basis for investigating that distinction, not a current measured
throughput result. Avoid fabricated UI scores and invented dashboard metrics.
