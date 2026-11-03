# Financial calculation audit

The audit follows three distinct routes: raw resale, resale of an existing
certified slab, and raw purchase followed by grading. Recent matched eBay
transactions from PKMNPrices are the primary resale evidence. Arithmetic is
deterministic; model answers do not set fees or decide the profit formula.

## Corrections

- **Purchase tax:** decimal half-cent rounding could understate acquisition
  cost. At 8.25%, a $62 item with free delivery costs $67.12, not $67.11.
  Purchase amounts and tax now use exact decimal ratios and integer cents.
- **Purchase limits:** whole-dollar rounding incorrectly rejected eligible
  cents-priced purchases. Ceilings now identify the largest cent amount that
  actually meets both targets after rounded purchase tax and fixed costs.
  For $267.92 net proceeds and a 25% target, a $198 purchase with 8.25% tax
  misses the target; $197.99 meets it. Limits are item prices, excluding the
  separately modeled acquisition delivery and purchase tax.
- **ROI:** retained ratios no longer round 24.6% into 25%. Display formatting
  remains separate from the exact target comparison.
- **Saved-result recalculation:** weighted grading proceeds use the same
  canonical cent amount during initial calculation and later recalculation.
- **Advertising:** a configured General promotion rate now uses the
  tax-inclusive selling-fee base, rather than excluding buyer tax. Default
  unpromoted fee policy remains unchanged. Fee components also retain exact
  decimal arithmetic through aggregate rounding: $157.50 with 10% buyer tax,
  a 10% fee and $0.40 order fee produces $17.73 rather than $17.72.
  See the [official fee-source review](financial-fee-sources-2026-11-03.md).
- **Slab evidence:** invalid prices and a summary for a different grader or
  certified grade cannot produce numerical buying advice.
- **Completed-sale amounts:** unknown historical sale types no longer set
  resale medians. PKMNPrices warns that an unknown row may contain the asking
  amount for an accepted offer. Confirmed auctions, fixed-price transactions
  and reported accepted-offer amounts remain eligible. Nonfinite prices are
  excluded before statistics are calculated.
  [PKMNPrices eBay sold-listing semantics](https://www.pkmnprices.com/docs/ebay-listings).
- **Offers:** nonfinite asking prices or limits cannot generate an offer plan.
  The existing maximum 10% discount policy remains in effect.

Only the financial/pricing revision changes. Paid photo/condition evidence is
retained; old computed prices/verdicts must refresh under the new revision.

## Worked transaction

An independent controlled example uses a $300 resale receipt, 10% buyer tax,
10% selling fee plus $0.40, and a $100 purchase plus $5 delivery with 10%
purchase tax. Raw outgoing shipping is $6; slab shipping is $8. The grading
example adds $35 in submission and allocated shipping costs.

| Route | Net sale proceeds | Total invested | Net profit |
| --- | ---: | ---: | ---: |
| Raw resale | $260.60 | $115.50 | $145.10 |
| Existing slab resale | $258.60 | $115.50 | $143.10 |
| Buy and grade | $258.60 | $150.50 | $108.10 |

These are test assumptions, not published fee defaults. Selling fees and
outgoing delivery reduce net proceeds once. Item price, incoming delivery,
purchase tax, and applicable grading costs form total invested once. ROI is
net profit divided by total invested. A slab incurs no new grading charge or
raw-condition estimation. Raw condition and the choice to grade remain separate.

## Bounded live sold-data check

Two PKMNPrices requests retrieved five recent English Base Set Charizard
Holofoil PSA 5 transactions and five raw transactions, sorted newest first
within 90 days. Response headers reported five data credits charged for each
page, ten total. No AI generations or eBay Browse requests were made for this
check. Responses were retained in shared SQL; detailed evidence is ignored
locally under `data/financial-audit/2026-11-03/`.

The five matched slab transactions had median $440 and observed range
$385–$475. An illustrative $300 item plus $7 incoming delivery, using the
configured costs and $50/25% targets, produces $332.33 invested, $366.97 net
sale proceeds and $34.64 profit: **PASS**, with a $264.20 target ceiling.
There is no specific purchase listing or independent photo verification in
this example, and five observations are not a complete market appraisal.

The raw sample contains materially different prices and has not had its
physical conditions independently checked in this probe. Its pooled average
must not become a condition-specific resale valuation. The bounded application
reuses accepted historical photo-condition evidence where available; it does
not launch new paid reviews of every sold raw card. With insufficient matched
condition evidence, the existing clearly labeled market fallback remains.

## Verified formulas and remaining assumptions

The continuous ceiling derivation is correct before currency rounding:

`allowed investment = min(net proceeds − minimum profit, net proceeds / (1 + minimum ROI))`

`item ceiling = (allowed investment − grading costs) / (1 + purchase tax) − incoming delivery`

The implementation verifies cent amounts against actual rounded costs, rather
than trusting the unrounded inverse. It was independently compared with an
exhaustive cents oracle across 108 ceiling cases; 99,999 purchase amounts were
also checked against exact 8.25% tax arithmetic.
An additional 7,080 fee cases matched an independent decimal-arithmetic oracle.

Current defaults and limitations remain explicit:

- Preserve the configured account-backed selling rate. Published rates do not
  establish this user's current account terms.
- Resale quotes are modeled as pre-tax receipts with no additional shipping
  revenue; outgoing delivery is deducted. Unknown buyer-paid comp shipping
  does not become invented income.
- The $15 per-card grading shipping amount is an assumed allocation across
  a batch. A single-card shipment can cost more; grading-service taxes are
  not included. These are displayed as nonblocking financial assumptions.
- Grade-outcome weights are assumptions, not calibrated probabilities. Missing
  grade prices can still use the documented lower-grade fallback when observed
  prices permit it. No new grading probability model was introduced here.
- Numerical-grade scenarios do not cover every no-grade/alteration outcome.
- Grading turnaround and resale time are not predicted by the profit formula.
- The lowest equivalent live Buy It Now ceiling for a slab auction remains
  future work requiring matched, available purchase alternatives. An auction
  closing-price forecast is also separate from a profitable snipe ceiling.

This audit does not implement price-first search admission, new AI routing,
liquidity forecasts or the later interface redesign. Its accompanying eBay
allowance correction changes the mistaken shared temporary development cap to
25 transport requests per search, while retaining account-wide daily protection
and the independent hard $0.02 AI cap.

## Validation

All 702 offline tests, both TypeScript projects, the production build and
whitespace checks passed. Mocked real-HTTP tests verify that the 26th Browse
request is refused, a new search gets its own allowance, missing IDs fail before
OAuth and expired legacy settings cannot block new scoped searches. CLI tests
verify one stable scope across nested, parallel and later-stage work. No paid
providers are invoked by those tests.
