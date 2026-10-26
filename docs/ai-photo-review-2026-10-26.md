# AI photo-review update — October 26, 2026

Developed on `ai-photo-review`, based on `main` at `8b8911b`.
The user authorized committing the feature, updating `main` and pushing it to
GitHub as the latest commit. Consult Git for current delivery status.

## Behavior

Cards and listing analysis show whether AI completed the photo review, how many
photos it checked, the assessment date and condition confidence. Preliminary
discovery matching is labeled separately. “Your review needed” includes specific
limitations or concerns, so it no longer sounds like an automatic review queue.
Stock/blocked photo classification does not imply high grading confidence.

The optional **Deeper AI photo review · paid** asks for a focused second opinion
on visible condition, identity/printing clues and unresolved photo limitations.
It returns concise findings with listing photo numbers and specific seller-photo
requests. The original grade range, raw condition, confidence, financial scenarios
and assessment date remain intact. New visible concerns hold actionable purchase
and offer advice for review; positive/supporting notes do not promote a listing.
Existing counterfeit, identity and missing-price hard stops remain in force.

## Request and storage safeguards

- One initial request, zero SDK retries, maximum 8,192 output tokens, existing
  model/environment override and global adaptive AI concurrency limit.
- Up to eight unique useful photos from already cached listing details, selected
  across front, back and detail views. No eBay or pricing request is added.
- A clear unobscured non-stock front is required. Missing/unsuitable evidence
  requests seller photos before enabling a paid review.
- Concurrent duplicate requests share work. Results persist with an input key
  covering photo fingerprint, baseline assessment, title and review version.
  Reopening a matching saved report makes no AI request. Changed inputs require
  a new explicit request. The normal photo-analysis cache version is unchanged.
- Failures leave the baseline intact. Failed model attempts have a 30-second
  retry cooldown. Successful answers awaiting a failed disk write remain in a
  bounded 32-entry process cache so retrying storage need not pay again. This
  temporary recovery cache cannot survive a server restart or eviction.
- The server validates result structure and image citations. A newer baseline
  wins over a stale second opinion. The focused schema has no new grade, price
  or confidence fields.

## Verification

All **274 tests pass**, including new checks for duplicate/cached requests,
stale inputs, invalid photo references, blocked photos, provider failures,
disk-write recovery, conservative prior-condition rules, fake-card protection,
unchanged supporting assessments and new-risk removal from Deals/Offers.
An SDK test mocks its transport to verify the vision request, structured output,
token cap and lack of automatic retry. Client transport tests verify the new
endpoint and key-only request body.

Both TypeScript projects, direct typing of new tests, production build and
`git diff --check` pass.

The actual production client was exercised against a temporary offline fixture
server with four synthetic listings. Browser checks confirmed:

- Review status, count, date and confidence near the card/panel top.
- Original price/grade remain visible while the focused request runs.
- Saved findings, photo citations and seller-photo requests appear correctly.
- Reopening a saved review has no paid button; it survives a page reload.
- A new concern moves the listing from Deals to Review while keeping its
  original financial scenarios and provisional limit visible.
- A simulated failure keeps the earlier assessment, with a separate error.
- Stock-only photos disable paid review and show unknown grading confidence
  consistently in the summary and detailed evidence section.
- Desktop, 375px saved-report and 320px paid-action layouts wrap without
  horizontal overflow. No browser JavaScript errors were recorded.

**No real AI, eBay or price-provider calls were made for implementation tests or
browser verification.** These checks establish control flow and UI behavior;
they do not measure the accuracy of a live second opinion or certify a card.
Vision can still miss defects, and additional computation cannot recover detail
that the seller's images do not show. The report deliberately preserves that
uncertainty rather than automatically raising a bid limit.

Official references consulted for the vision/structured-output implementation:
[Images and vision](https://developers.openai.com/api/docs/guides/images-vision)
and [Structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
