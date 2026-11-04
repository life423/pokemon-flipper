# Candidate admission and broader slab validation

This change reduces unnecessary paid assessment before changing the production
model. Preliminary screening is not a Deal verdict: final advice still needs
physical identity, the applicable resale evidence and the existing money rules.

## Better use of the fetched search window

Search still fetches at most 200 summaries and retains at most 50 matching rows.
Confident preliminary price exclusions no longer occupy those 50 slots. The
search can fill their places from later summaries already fetched, without
another eBay search request. Missing or deferred sold prices remain in Sorting.

Every refill uses one screening session: catalog and sold-page promises,
cancellation and the 32-request preliminary allowance remain shared. It does not
renew that allowance per batch or change the persistent 64-request all-stage
price allowance, 25 actual Browse requests per search, daily eBay protection or
$0.02 generation cap. Request counts, listing counts and provider credits are
separate measures.

Rows are emitted only after selection and ranking finish. Equal-priority rows
retain source order through the server, browser and diagnostic queue instead of
being reordered by listing ID. Financial and evidence priorities still win.
Repeated IDs within the source window are screened once. Successfully completed
price exclusions enter new-ID discovery history without becoming displayed
results, so repeated Find new listings scans do not screen them as new again.
Cancelled or unprocessed rows are not marked seen. This history is not a lasting
price rejection: ordinary searches still reconsider current terms and targets.

Summary fields distinguish price-screened rows, price exclusions, retained rows
and unprocessed inventory. The interface explains that excluded rows require a
new search after relaxing targets or enabling offers; local retargeting applies
to retained results. Final assessed PASS visibility is unchanged.

An offline regression places a worthwhile listing after 50 overpriced slabs.
It is admitted using one source page, one shared catalog lookup and one sold-page
lookup. The fixture does not claim that a real current opportunity exists.

## Keep readable listing identity out of expensive ambiguity

Known publisher wording and explicit accompanying slab-holder suffixes are
cleaned only from the input used to extract a card name. Holder suffixes require
an explicit connector and a recognized numerical grader/grade. Unknown name
words, printed forms and owners are preserved. All junk, grade, printing and
finish checks continue using the untouched seller title.

This lets the existing upper-observed-sold-price exclusion operate when the
title already states one exact market. No scope safeguard or financial formula
was relaxed. Missing sets/numbers, special labels, alternative printings,
conflicting metadata and incomplete prices remain protected.

A selected-market replay of six saved CGC rows against saved catalog and sold
data reduced automatic eligibility from three listings to one. The two newly
excluded listings had explicit identities previously lost during name parsing.
The missing-set case stayed unresolved. This replay used no new provider,
preflight, image or generation requests and did not refresh live availability.

## Six additional saved model comparisons

The diagnostic checked three PSA 5 and three CGC 9 examples with GPT-6 Luna.
New generation cost was **$0.0047467 (0.47467 cents)**: 34,342 input and 2,625
output tokens across six exact-input preflights and six generations. It used
each example's original search UUID; all retained their two-cent ceilings and
zero unresolved holds. Preparation downloaded five known image-CDN photographs.
No eBay API or PKMNPrices requests were made.

Core holder, grader, grade, card, number, language and certificate fields matched
manual references on all six controls. Three ordinary PSA EX descriptions were
returned as qualifiers and correctly normalized by the existing grade rules.
One CGC stamp remained uncertain. Saved-only production interpretation resolved
all six to the correct Unlimited identity with slab checks OK, without inventing
a premium printing or buying a second opinion.

Strict replay added zero provider work or spending. All six original accepted
source cache records remained present and unchanged. Diagnostic answers stayed
separate from production assessments.

These controls extend the earlier three PSA 7 checks. They still do not validate
BGS subgrades, half-grades, qualified labels, TAG, foreign labels or wrongly
categorized raw cards. Historical inline bytes were not retained, so historical
cost comparisons are not simultaneous identical-input trials. Production model
defaults remain unchanged; automatic stronger-model escalation remains pending.

Model input/output support and published rates were checked against the
[official GPT-6 Luna documentation](https://developers.openai.com/api/docs/models/gpt-6-luna).
The measured diagnostic cost comes from returned usage under the existing guard,
not a promise about the cost or quality of a complete search.

Actual profitable-Deal validation and the wider photo-quality, pricing-history,
auction, UI and durable-worker roadmap remain separate unfinished work.

## Verification

All 874 offline tests pass under both the existing default and an explicit
GPT-6 Luna slab override. Both TypeScript projects, production build and
whitespace checks pass; the local app returns HTTP 200. A pre-existing shared
price-transport test now explicitly establishes its first sponsor instead of
depending on asynchronous cache-read timing. No production transport behavior
changed for that test correction.
