# Flexible search — October 30, 2026

Implemented on `codex/flexible-search` from main `4173839`. The user requested
queries like “aquapolis cards psa 7 or better holo”. The user subsequently
authorized committing the changes, merging into `main`, and pushing to GitHub.
Consult Git for the resulting revision and remote synchronization. No deployment
was requested.

## Behavior

The existing field accepts ordinary phrases, set-wide searches and named cards.
The interpreter returns the card/set, printing, raw/graded preference, requested
grader, inclusive slab-grade bounds and finish. It also returns compact eBay
keywords. The original query remains visible/editable, with a short explanation
of the applied criteria above search progress. Starter/help examples teach the
new syntax without another form. Search and listing-link drafts remain separate.

Examples:

| Query | Criteria |
| --- | --- |
| Aquapolis cards PSA 7 or better holo | Aquapolis, existing PSA slabs 7–10, holo |
| PSA 8+ Aquapolis holos | Aquapolis, existing PSA slabs 8–10, holo |
| Show me Aquapolis holo cards graded seven or higher by PSA | Same as the first example |
| Neo Genesis Lugia CGC 8.5 to 9.5 | Lugia, Neo Genesis, CGC 8.5–9.5 |
| Aquapolis PSA 8 holo | Exact PSA 8, holo |
| Raw Base Set Charizard non-holo | Raw, Base Set, Charizard, non-holo; the app may find no genuine matching printing |

“Holo” excludes reverse holo and non-holo; those finishes can be requested
explicitly. Grades refer to existing slabs, not a prediction of how a raw card
will grade. The existing potential-grade and financial filters stay independent.
Pricing still supports PSA and CGC; recognizing another grader does not add its
pricing support. This is a card/set/grade/finish interpreter, not a promise to
enforce every possible shopping instruction (for example, arbitrary price or
seller exclusions in prose). Users can see the reading and edit/rerun it.

## Safeguards and API use

Intent schema/cache version 2 uses the existing model, limiter and structured
output client. All schema keys are required with nullable values for unspecified
criteria, following [official structured-output guidance](https://developers.openai.com/api/docs/guides/structured-outputs).
One intent request is cached for a month. Title, comp, photo and assessment
caches are retained; there is no analysis-cache invalidation or dependency change.
Rules independently enforce common explicit numeric grade operators and finish
words, including when AI interpretation fails. General set/name and spelled-out
grade interpretation still need the model. Card numbers/years must not create a
grade filter, and generic filler words cannot become required title words.

A range sends “aquapolis holo PSA” to eBay, not the literal “PSA 7 or better”.
Exact grades may narrow the marketplace query. Known conflicts in title claims
stop before title batching or, after title reading, before pricing/photos.
Existing item-detail checks can settle absent title information; unknown required
criteria cannot queue full automatic analysis if they remain unresolved. Item
specifics and independently read slab labels/finish are checked again. A full
photo assessment that contradicts the query is excluded from keyword results;
direct-link evaluation and the shortlist remain independent.

Discovery shares the same constraints and existing photo budget. A broad graded
set query makes one targeted wrong-category query; raw set/vintage expansions
are skipped for graded searches. Wrong graders/low grades are excluded before
discovery photo checks. The existing new-listing route uses the same findDeals
pipeline, so it receives the compact query and constraints too. No background
polling, expanded analysis budget or automatic provider-limit retry was added.

## Verification and observed limits

All **331 unit tests**, both TypeScript projects, production build and whitespace
checks pass. Thirteen new regression cases cover operators, exact/range query
construction, numeric and finish safety, unknown criteria, provider-call gates,
item specifics, discovery and contradictory full photo evidence.

Live evidence/harnesses are saved in ignored
`data/reviews/flexible-search-2026-10-30/`:

- Four actual model interpretations passed: the user's phrase, spelled-out seven,
  a CGC half-grade range and raw/non-holo. Both Aquapolis phrases generated the
  same compact query and PSA 7–10 criteria.
- **14 live browser checks**, including five axe scans, exercised one real
  200-result search, automatic discovery, mobile touch open/close, draft/link
  switching and 320/390/768/1440px layouts. No routes were mocked for that run.
- The main search screened 111 eligible listings with ten eBay detail requests.
  Combined with discovery it streamed 114 records; 107 matched, including PSA
  7, 8, 9 and 10. Seven were set aside. The single extra query checked 20 photos.
  These are bounded windows, not exhaustive eBay coverage.
- **73 matching listings were incompletely screened**, including 65 affected by
  pricing-provider rate limiting/cooldown. Cached prices still worked. Three
  priced candidates were long-shot auctions, so automatic full analysis did not
  start. Zero Deals does not mean there were no opportunities in unpriced cards.
  The new partial-screening notice makes that limitation visible and directs
  users to All for per-card reasons.
- One matching cached-comp Nidoking listing received a real manual paid analysis
  via its link in the phone UI. It finished in 16 seconds, identified Aquapolis
  H18/H32 holo, and confirmed an OK PSA 9 slab. The final shared query check
  accepted it. Its photo step used 5,473 input and 1,526 output tokens; those
  counts do not measure every provider charge. Observed BUY_GRADED is an app
  result at the current auction bid, not an independently verified profitable buy.
- **Six UI-only checks**, including four axe scans, replayed the captured actual
  stream to verify the new partial-screening notice and final layouts without
  issuing another large provider batch. They include 200% root text at 320px.
  The final replay was repeated after allowing search-field controls to wrap,
  preserving a usable input width at enlarged text. No page errors were recorded.

Actual screenshots were inspected for phone, desktop and enlarged text. Existing
unit regressions cover cancellation, budgets and listing-link behavior. No claim
is made of physical-device keyboard behavior, human screen-reader quality,
exhaustive marketplace recall, grading accuracy or production Core Web Vitals.

## Internal design review

These are conservative review heuristics, not measurements: usability 9,
hierarchy 9, accessibility 8.5, consistency 9, responsiveness 9, feedback 9,
performance 8. The single field, existing tokens and visible interpretation keep
the workflow consistent. Priorities below 9: human screen-reader/physical-phone
testing, then provider-throughput and production latency/Web Vitals measurement.
Pricing cooldown is the main observed throughput limitation; respect it rather
than repeatedly forcing paid lookups. Further broad redesign is not warranted.
