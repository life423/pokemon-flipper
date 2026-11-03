# Graded and raw assessment paths — November 3, 2026

The bounded evaluator now requests different photo work for a claimed slab and
a raw card. Existing accepted photo evidence remains reusable. This is a task
split on the existing model, not a model migration or a complete search-cost
benchmark.

## What changed

`server/analysis/bounded-plan.ts` owns advisory routing, photo selection and
versioned cache inputs. A clearly graded seller category or label claim can
choose a short slab-label request. Ungraded and uncertain raw-grade claims keep
the combined raw request. Seller metadata never establishes the physical
holder or the certified grade used for money calculations.

`server/ai/bounded-assessment.ts` owns the structured requests:

| Work | Selected photos | Output ceiling | Condition output |
| --- | --- | --- | --- |
| Raw identity, condition and supported grading potential | Existing gallery-spanning sample, up to six unique photos | 2,200 tokens | Supported raw category/range, or explicit unknown/null |
| Slab identity, actual label and case evidence | First two unique photos | 1,600 tokens | Always null; no raw category or predicted new grade |

Both requests use the existing bounded transport, exact immutable-input
preflight, maximum-cost reservation, no retries and no automatic second opinion.
The strict schema retains per-image coverage, actual card identity, printing,
half grades, qualifiers, certificate text and visible case/authenticity evidence.
The schema follows the [official structured-output requirements](https://developers.openai.com/api/docs/guides/structured-outputs).

Observed slab evidence still follows the exact certified grader/grade resale
path. Raw work retains separate as-is resale and supported raw-to-grade paths.
If the short request disproves the seller's slab claim, it saves that answer
without silently buying a second raw-condition assessment. Missing photographs
and uncertain details are not filled in from seller wording.

## Preserve paid work

- The existing raw request body, schema, combined cache key and six-photo
  selector remain unchanged. Extracting the code does not invalidate them.
- A new slab-specific version uses the existing public assessment namespace;
  it never overwrites a combined answer with a two-photo answer.
- Both applicable shared records are validated. Newer applicable evidence wins,
  with its original selector, numbering and version; equal timestamps prefer
  already-paid broader coverage. Stronger legacy full assessments retain their
  existing preference.
- A verified cached slab can satisfy a raw-request hint after a seller category
  change. A short answer showing a raw/unknown holder cannot substitute for
  raw-condition assessment. Corrupt evidence stops work instead of buying a
  replacement. Private pricing reuse recognizes the new slab version.
- Accepted answers save after Stop; downstream market work stays cancelled.
  The two-cent per-search AI guard, twenty-five Browse requests per search and
  separate daily protection remain in effect.

The requests, selection and evaluation orchestration now live in separate
modules. Compatibility exports preserve existing consumers. No SDK/dependency,
model, database-schema or grading-fee changes were needed.

## Validation and measured cost

All 820 offline tests pass, as do both TypeScript projects, the production build
and whitespace checks. New regressions exercise strict schemas, unchanged raw
request fingerprints, compact slab pricing, both cache-correction directions,
original photo numbering, metadata-category changes, absence of hidden paid
fallbacks, corrupted evidence and cancellation.

One controlled real assessment used an existing cached Dark Blastoise listing
and two source photos. Two other candidates with compatible saved assessments
were skipped before choosing this uncached example. The answer correctly read
Dark Blastoise, Team Rocket, 3/82, English, holo, PSA 5 and the photographed
certificate. It returned no raw condition or new grade.

- Input: 7,232 tokens. Output: 575 tokens.
- One settled generation: **$0.0021364**, or **0.21364 cents**, in recorded token
  charges. No unresolved reservation remained.
- Zero eBay Browse requests and zero new PKMNPrices requests in this step.
- The accepted answer is saved in the shared SQL cache. A replay through the
  evaluator used zero further AI or provider requests, retained the two-photo
  mapping and validated PSA 5. Missing cached sold prices stayed unavailable
  because that replay explicitly prohibited new provider work.

Private input/output and replay evidence are retained under ignored
`data/assessment-route-audit/2026-11-03/`. A duplicate derived inline-image file
was removed after validation. The localhost3017 storage check reports SQL ready.

This is one assessment test, not a full search or general model-accuracy/cost
claim. The deferred early-stop/progress report and photo/language examples were
not repaired in this change. A controlled complete-search benchmark is next;
future model/OCR tiering should be evaluated by total cost per accurate useful
result while preserving reusable observations.
