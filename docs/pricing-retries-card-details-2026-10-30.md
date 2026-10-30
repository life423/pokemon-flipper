# Pricing retries, card details and motion — October 30, 2026

Implemented on `codex/pricing-retries-card-details` from main `08be1a3`.
The user requested targeted pricing retries, grade/finish on cards, preserved
behavior and reasonable API use, with end-to-end mobile verification. They then
requested selected animations from their portfolio. The user subsequently
authorized committing the changes, merging into `main`, and pushing to GitHub.
Consult Git for the resulting revision and remote synchronization. No deployment
was requested.

## Pricing retries

Incomplete screening now separates temporary price-service failures from
identity/evidence/price-data problems. **Retry pricing** becomes available when
the cooldown expires, with an immediate busy state, Cancel and completion/error
feedback. A local countdown makes no polling requests. Existing results remain
usable while the batch runs. Per-card reasons distinguish provider pauses from
identity or missing-data review.

The queue uses these limits:

- Explicit requests only, at most five opaque tickets per batch; duplicate
  tickets deduplicate, and only one batch runs across the server at a time.
- At most three attempts per snapshot, at least 30 seconds between failed
  attempts, 1.5 seconds between queue jobs and one second between uncached
  price-provider request starts (existing two-request concurrency stays).
- Seconds or HTTP-date Retry-After values extend the provider-wide cooldown.
  A new throttle pauses the remainder without spending their attempts. Cached
  responses remain available. Credit/configuration failures ask for account or
  setup review and do not get ordinary retry tickets. The credit circuit uses
  Retry-After, or a conservative one-hour hold if the provider gives no reset.
- Up to 2,000 server-held jobs, expiring after 30 minutes. Tickets are local to
  this server process; a restart or expiry returns an actionable 410 and keeps
  the visible search results. This is not a durable background job service.

The endpoint accepts tickets and financial targets, never a listing snapshot
from the browser. Jobs retain trusted screening inputs and original search
intent. Successful duplicate requests return the stored result. Recovered
identities still have to match the original search.

Retries run only deterministic identity/pricing/comp rules. They do not run
eBay searches, fetch listing details, read titles/photos, or request AI comp
checks. Existing card/comp caches and their age policies remain in force.
Listing terms remain as last checked; use existing refresh/fresh-analysis
controls for current eBay terms. The normal automatic-analysis setting still
applies to newly found candidates; its budget is not increased by retries.

Typed price errors survive the identity layer's intentional error-to-review
conversion. Genuine missing identity/printing/comp support is not repeatedly
retried. On the client, snapshot keys cover title/photos, seller attributes,
grade state and price/shipping/bids/end time. Late results cannot overwrite a
different snapshot; evaluated/analyzing IDs are skipped, and assessments are
never cleared. Cancel or a new search aborts the client request and prevents
subsequent queue jobs. A request already sent may finish; its successful result
is reusable without another provider call.

## Grade and finish

Every card header has an accessible text line, for example:

- **Listed: PSA 8 · Holo** before full analysis.
- **Label checked: PSA 9 · Holo** after an OK slab check.
- **Listed: Raw · Reverse holo** for an unassessed raw card.
- **Review needed: PSA 9 (OC) · Finish unknown** for an uncertain/qualified label.

The line uses actual seller title/item specifics, then independent assessment
fields. It never displays a predicted raw grade as a slab grade, and unknown
values remain explicit. Fresh server details replace stale attributes, and the
shortlist validates/preserves those claims. The card's accessible Open name also
includes the details, distinguishing copies of the same card. The old duplicate
certified-label line lower in the card was removed.

## Selected portfolio animations

The user supplied [their portfolio animation plugin](https://github.com/life423/drewclark.io-portfolio/blob/main/app/src/styles/plugins/animations.js).
The app uses CSS Modules, so only the useful effects were adapted rather than
adding Tailwind or another animation dependency:

- Short slide/fade card entrances, 220ms, with stagger capped at 80ms.
- Selected-mode underline using a 150ms transform transition.
- A 150ms pricing-feedback fade and a 220ms one-shot saved-check confirmation.

They reuse existing colors, durations and easing. No persistent animation hints,
blurs, looping attention effects or layout-sized underline animations were added.
There is no permanent will-change layer. Reduced-motion mode explicitly stops
the new effects. Existing filtering/view transitions remain in place.

## Verification

All **345 unit tests**, both TypeScript projects, production build and whitespace
checks pass. Fourteen new regression tests cover typed pricing failure signals,
cooldown/Retry-After, no work before readiness, duplicate sharing, bounded
attempts, global concurrency, pacing, cancellation, forged/expired tickets,
changed snapshots, recovered identity matching and truthful header labels.

Live evidence is in ignored `data/reviews/pricing-retries-2026-10-30/`:

- **15 live browser checks**, including five axe scans, used the actual app,
  eBay and pricing clients. The warm-cache sample did not naturally contain a
  temporary failure, so a test-only preloader bypassed one existing comp-cache
  read without deleting/editing that file, and injected one network TypeError
  for that lookup. No fake provider response or listing data was returned.
- The normal application classified the failure, issued two eligible tickets,
  disabled early retries with a visible countdown, then recovered both listings
  through the phone button. Provider instrumentation recorded **one actual
  pkmnprices request** during the retry and **zero eBay or OpenAI requests**.
  The refreshed response was saved by the normal cache code. The other 17
  incomplete listings stayed in review. No second broad search was launched.
- The live browser verified Listed headers, bounded updates, forged-ticket
  rejection, existing assessment reuse, Label checked headers, 320/390/768/1440px
  layouts, 200% root text and absence of page errors.
- **12 supplementary UI checks**, including four axe scans, replayed the captured
  actual search stream for final motion/layout checks without another provider
  batch. Actual shortlist save/remove and cached retry endpoints remained real.
  The temporary saved entry was removed through the UI and the original
  shortlist contents were compared unchanged. A held actual cached response
  exercised cancellation; no response payload was fabricated.
- Motion checks observed the named one-shot animations, duration/stagger and
  selected-mode transition, then confirmed they stop under reduced motion.
  Actual phone/tablet/desktop and enlarged-text screenshots were inspected.

The first browser harness had a response-body capture race after the app canceled
its completed stream reader. The harness now clones the real fetch response for
capture, preserving normal live streaming. This required no product workaround.
Physical-device keyboards, human screen readers and production Web Vitals were
not measured. Broad-search provider limits can still defer missing prices; no
claim is made that every listing can be priced or that an observed opportunity
is a guaranteed profitable purchase.

Internal design-review heuristics, not measured quality claims: usability 9,
hierarchy 9, accessibility 8.5, consistency 9, responsiveness 9, feedback 9 and
performance 8.5. Prioritize real-device/screen-reader validation and production
provider-throughput/Web Vitals measurements before more visual polish.
