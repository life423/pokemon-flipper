# Price research accounting — November 3, 2026

The previous eight-request allowance applied only to preliminary screening. It
was not eight PKMNPrices credits and did not include later valuation calls.
That limit could leave useful markets unresearched while the subscription had
substantial daily capacity.

Screening now permits 32 uncached requests. Screening, final raw/slab valuation,
catalog lookups and transport retries share one durable 64-request allowance
per search UUID. These are request safeguards, not dollar or credit ceilings.
The persistent $0.02 OpenAI cap and 25 actual eBay Browse requests per search
remain unchanged, along with eBay's daily quota and reserve.

PKMNPrices charges credits by returned items and reports the charged amount and
account counters in response headers. A 20-sale response can consume 20 credits.
The user's subscription has 20,000 daily credits; request count alone cannot
prove the remaining account balance. See the
[provider's rate and credit documentation](https://www.pkmnprices.com/docs/rate-limits).

## Implementation

- `server/pricing/research-budget.ts` reserves before dispatch with atomic
  writes, process locks and exclusive file leases. Failed or unknown attempts
  remain counted. Restarting, changing days or retrying the same search does
  not reset its allowance. Invalid accounting fails closed.
- `server/pricing/pkmnprices.ts` applies the guard to preliminary and final
  transport, including each retry. Shared requests retain independent
  subscribers; one caller stopping does not cancel another caller's work.
  Identical path/expiry requests share one transport across screening and final
  valuation. Screening does not gain final valuation's retry loop or later
  sold pages. Queued, paced and retry work checks cancellation before dispatch.
- Accepted provider responses finish accounting and cache storage after Stop.
  Existing response keys and expiry rules are preserved, using the configured
  Azure SQL or file backend. No cached payloads are copied into the ledger.
- Final evaluation checks price-research availability before a new photo
  assessment. Saved photo evidence remains reusable. A limit reached during
  pricing preserves completed routes and marks missing routes deferred.
  Price-only gaps stay in Sorting; physical identity or authenticity concerns
  still need attention. A supported profitable route can still be a Deal.
- The existing usage endpoint includes a separate price-research summary:
  requests, pending/unknown outcomes, reported credits and the last observed
  provider account headers. Missing credit headers are explicitly unknown.
  Reading usage performs no marketplace, price-provider or generation call.

## Boundaries

The request ledger is local to this app and the configured API-key namespace.
It does not establish provider-account identity across key rotation, other
applications or independent replicas. Response singleflight is in process;
durable request limits cover processes but do not create distributed response
deduplication. Azure SQL continues storing reusable responses and accepted
assessments; normalized long-term sold history and shared spending authorities
are separate unfinished work.

The 64-request allowance is an upper bound, not a target to spend. More requests
do not prove a card is profitable, improve photo accuracy automatically or
guarantee finding a current deal. Recent matched sold transactions and the
unchanged fee engine still determine valuation and category.

## Verification

All 830 offline tests, both TypeScript checks, production build and whitespace
checks pass. Tests include cross-process request limits, accounting failures,
unknown outcomes, cache reuse at exhaustion, shared-request sponsorship and
Stop, partial raw/PSA/CGC results, resumed pricing without new photo work and
credit-display distinctions. The local HTTP storage check reports Azure SQL
ready. The HTTP usage response agrees with the persisted benchmark counters.

One controlled live Buy It Now search for English Base Set Unlimited Charizard
4/102 in PSA 7 returned 11 matching rows and completed three label assessments.
The other eight rows were excluded from automatic assessment by sold-price
screening. Final grouping used the production result selectors and Any
profit/ROI targets; all three assessed listings were PASS, with no Deals,
errors, Sorting or manual-attention results. This is a negative market sample,
not evidence that a current opportunity was found.

| Measurement | Live run | Saved replay |
| --- | ---: | ---: |
| OpenAI generations | 3 | 0 |
| Reported OpenAI cost | $0.003991 (0.3991 cents) | $0 additional |
| eBay Browse requests | 3 | 0 |
| PKMNPrices requests | 5 | 0 |
| Provider-reported credits charged | 65 | 0 additional |
| Unresolved requests / spending holds | 0 | 0 new |

Provider headers reported a 20,000-credit daily limit and 19,217 remaining after
the live run. eBay Analytics reported 4,957 of 5,000 Browse calls remaining.
Those are observations at this checkpoint, not projected current balances.
The live run also used two Analytics calls, one OAuth call, six photo downloads
and three OpenAI input-count preflights; these are separate from Browse calls
and generation charges. It completed in approximately 37.5 seconds, not a
browser timing test. The strict replay prohibited provider transports and
reused all three assessments with the original search ID; persisted counts did
not reset. Detailed responses and diagnostic artifacts remain Git-ignored.
