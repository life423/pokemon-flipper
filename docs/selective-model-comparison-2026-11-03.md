# Selective model comparison

This diagnostic evaluates cheaper slab-label checks and focused printing reviews
against saved examples. It does not change the app's default model, normal
assessment prompts, cache keys, admission rules or financial recommendations.

## Boundaries and reuse

- Existing slab-label requests retain their prompt, schema, two selected images
  and 1,600-token output limit. Only the experimental model changes.
- Focused printing requests ask one unresolved edition-stamp question using a
  native-pixel crop and a short, explicitly fallible prior observation. They
  cannot assign condition, a future grade, authenticity or a price.
- Frozen inline image bytes, source-answer fingerprint, exact model, question,
  schema and output limit identify each experiment. Diagnostic answers occupy
  a separate owner-scoped SQL cache; accepted production evidence is preserved.
- New work shares each example's **original search UUID and remaining $0.02
  generation allowance**. Exact input counting and maximum input/output
  reservations remain mandatory. No replacement ID, automatic retry or budget
  reset is used. Stop prevents later dispatch while accepted answers finish saving.
- The diagnostic transport permits no eBay Browse or PKMNPrices requests.
  Missing saved source images can be downloaded from the known eBay image CDN
  during explicit live preparation. Replay requires saved image bytes and
  answers, failing before generation or reservation on a cache miss.

The candidate GPT-6 Luna rates added to the spending guard are $0.10 input,
$0.01 cached input, $0.125 thirty-minute cache write and $0.50 output per million
tokens. Historical model rates remain unchanged, so existing reservations still
validate. These are the published default-tier rates, not a claim about the
cost of a complete search. [Official model documentation](https://developers.openai.com/api/docs/models/gpt-6-luna).

Focused reviews use the already-supported GPT-5.6 Terra model and its existing
verified rates. A compact question can fit a remaining allowance where another
full assessment would not. [Official model documentation](https://developers.openai.com/api/docs/models/gpt-5.6-terra).

## Measured November 3 results

| Work | New generation cost | Observed result |
| --- | ---: | --- |
| Three GPT-6 Luna slab checks | $0.0018122 (0.18122¢) | Correct card, holder, PSA 7 and certificate transcription on all three controls. |
| Two focused GPT-5.6 Terra stamp checks | $0.0024200 (0.24200¢) | Both matched manual inspection: one empty stamp region, one visible First Edition stamp. |
| Entire five-case diagnostic | **$0.0042322 (0.42322¢)** | Five accepted answers, no unresolved spending holds. |
| Strict saved replay | **$0** | Five answers reused; zero generation, preflight, image, Browse or price requests. |

The slab checks used 12,467 input and 1,131 output tokens. The historical
GPT-5.6 Luna checks of these three listings cost $0.003991, so this small slab
sample cost **54.6% less**. Broader search and raw-card savings remain unmeasured.

Two raw transcriptions put ordinary PSA “NM” wording in the qualifier field.
Existing grade-specific normalization correctly removes that ordinary description;
all three results pass the existing slab check with no qualifier or review
reason. The low-resolution example leaves the stamp uncertain, but its complete
ordinary PSA Base Set label still resolves Unlimited through the existing label
rule. Raw observations and interpreted results remain separately visible in the
diagnostic report; neither was rewritten to conceal a discrepancy.

Focused reviews used only 592 input and 103 output tokens in total. Each kept
the prior observation as fallible context and revisited one small image region,
without repeating raw condition, grading or price work. The positive stamp
control's original wrong answer had already been superseded by a later ordinary
assessment; this diagnostic tests the focused technique, not a newly deployed fix.

The live run made five exact-input preflights, five generations and three
image-CDN downloads. It made **zero eBay API and PKMNPrices requests**, with
zero cached-input, cache-write or reasoning tokens reported. The three original
searches ended at 1.53404¢, 0.58032¢ and 1.48004¢ including their earlier work;
each retained its two-cent maximum. Production assessment fingerprints stayed
unchanged. All **846 offline tests**, both typechecks and the production build pass.

Run the diagnostic explicitly from the checkout:

```sh
node --import tsx scripts/compare-saved-models.ts --live
node --import tsx scripts/compare-saved-models.ts --replay
```

The ignored manual manifest, prepared source bytes and per-run reports live under
`data/model-comparison/2026-11-03/`. Live mode requires SQL dispatch claims;
replay cannot purchase a missing answer. No production model switch or automatic
escalation is enabled by this diagnostic.

## Limits of the experiment

The three slab controls are homogeneous English PSA 7 Base Set Charizards.
Manual transcription is a reference for readable fields, not certificate
authentication. Two stamp crops test a visible positive and a clear empty region;
their locations were selected manually. This does not validate automatic crop
selection or reliable condition grading across all listings.

Historical inline image bytes were not retained. Current images are frozen and
hashed for repeatability, but comparisons with historical answers are not a
controlled simultaneous A/B test. A previously wrong stamp answer is preserved
in its original fixture; its production cache later received a corrected answer.
The experiment fingerprints the original fixture rather than misrepresenting the
current cache as that historical response.

Correct labels, cheaper requests and useful fact corrections alone do not prove
profitable buying. A material printing correction requires matching-price
research and deterministic recalculation before becoming a recommendation.
No diagnostic answer automatically creates a Deal.

The next gate is a more varied saved reference set, including other graders,
qualified labels, reprints, low-quality views and metadata conflicts. A future
queue integration must preserve compatible existing answers and selectively
request only a consequential unresolved fact. It must not automatically run
both models for every listing or turn weaker evidence into a confident Deal.

## Stopping checkpoint

The slab model is now independently configurable with
`OPENAI_BOUNDED_SLAB_MODEL`. The default still follows the existing bounded
model; this checkpoint does not automatically switch production to GPT-6 Luna
or enable stronger follow-ups. Raw requests and their original keys are unchanged.
Compatible readers retain both compact models and older combined assessments,
including after a rollback. Existing private valuations remain reusable, newer
accepted corrections take precedence, and corrupt historical payloads fail
closed rather than authorizing another purchase.

The diagnostic supports 1–12 inspected cases, requires each original listing's
paid search history, checkpoints partially prepared inputs, and reports raw and
normalized label comparisons separately. Additional manually inspected examples
are retained privately for the next validation pass; that pass is unfinished.

A separate normal CGC 9 Charizard Buy It Now search returned six matching rows,
completed three ordinary slab checks, and found zero Deals, with no errors or
attention cases. It used four Browse requests, four PKMNPrices requests reporting
27 credits, and $0.0044524 (0.44524¢) of generation spending, with no unresolved
holds. It supplies current CGC reference cases, not a successful cheaper-model
validation or evidence of a general CGC price increase.

All **858 offline tests pass under both the existing default and explicit
GPT-6 Luna slab configuration**, with typechecks, build and whitespace checks
passing. Broader accuracy validation, selective stronger-review integration and
positive-Deal validation remain pending.

## November 4 extension

Six additional saved PSA 5 and CGC 9 controls cost $0.0047467 (0.47467 cents).
Core slab fields matched all six manual references; existing normalization and
canonical identity rules resolved all six without review or a premium upgrade.
Strict replay added no provider work and original assessments stayed unchanged.
This still leaves other graders, half-grades and qualifiers unvalidated; defaults
remain unchanged. See [candidate admission and validation](candidate-admission-2026-11-04.md)
for the method, limits and related screening improvements.
