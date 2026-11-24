# Money calculations and evidence

The application computes costs in code from accepted evidence. Model answers
describe identity, condition and visible risks; they do not invent a fee rate,
sale amount or profitable purchase limit.

## Code to follow

- [Configuration and verification flags](../shared/money/config.ts).
- [Integer-cent and exact-ratio arithmetic](../shared/money/cents.ts).
- [Acquisition, sale, grading and purchase-limit calculations](../shared/money/underwriting.ts).
- [Price provenance and route eligibility](../shared/money/price-evidence.ts).
- [Matched-sale estimate selection](../shared/sold-evidence.ts).
- [Retargeting saved evidence](../shared/money/targets.ts) and
  [financial regression cases](../test/money/financial-audit.test.ts).

Current fee sources and their limitations are maintained in
[financial-sources.md](financial-sources.md). Avoid copying configurable rates
or user controls into a second calculator.

## Transaction model

Let `P` be item purchase price, `S_in` incoming delivery, `t_buy` purchase tax,
`R` modeled pre-tax resale receipts, `F(R)` the applicable selling/advertising
fees, `S_out` outbound delivery/supplies and `G` any new grading costs.

```text
acquisition = rounded purchase tax on (P + S_in), added to P + S_in
net resale = R - F(R) - S_out
total invested = acquisition + G
profit = net resale - total invested
ROI = profit / total invested
```

The engine applies purchase tax to item plus incoming shipping. Selling fees
use their configured tax-inclusive transaction base, tiers and order fee.
The modeled resale receipt does not include invented buyer-paid shipping
revenue. Outgoing shipping is deducted once, and acquisition shipping is charged
once. An unknown acquisition quote can support an explicitly assumed scenario;
it cannot qualify as a verified delivered-cost recommendation.

Three independent routes use this model:

| Route | Resale evidence | Additional acquisition costs |
| --- | --- | --- |
| Sell raw | Accepted same-condition or supported lower-condition sold copies | No new grading |
| Resell an existing slab | Exact printing, finish, language, grader and certified grade | No new grading |
| Buy raw and grade | Photo-supported grading scenarios and matched grade prices | Selected service plus allocated round-trip shipping |

An unavailable route does not erase another independently supported route.
Grade-specific resale prices cannot be presented as the current value of an
ungraded copy without the separate grading route and its costs.

## Purchase ceiling

Before currency rounding, the ceiling follows:

```text
allowed investment = min(net resale - desired profit,
                         net resale / (1 + desired ROI))
item ceiling = (allowed investment - G) / (1 + t_buy) - S_in
```

The actual engine tests cent amounts against rounded costs and both requirements.
A continuous inverse or whole-dollar rounding can overstate the affordable bid.
The displayed limit is an item price; shipping and tax remain separate components.
ROI is compared before display formatting. Any profit/ROI removes the selected
minimums while a verified Deal still requires a positive supported net outcome.

The independent regression examples include:

- A half-cent purchase tax boundary that rounds the acquisition up correctly.
- A cent-priced ceiling immediately below a purchase that misses its ROI target.
- General advertising charged on the tax-inclusive fee base.
- Consistent initial and later retargeted grading proceeds.
- Invalid terms, wrong-grader summaries and unknown transaction amounts failing
  before actionable buying advice.

An independently checked illustrative transaction uses `R = $300`, 10% future
buyer tax, a 10% fee plus $0.40, and a $100 purchase plus $5 incoming delivery
with 10% purchase tax. These are test inputs, not current defaults:

| Route | Net resale | Total invested | Profit |
| --- | ---: | ---: | ---: |
| Raw; $6 outbound | $260.60 | $115.50 | $145.10 |
| Existing slab; $8 outbound | $258.60 | $115.50 | $143.10 |
| Grade; same slab sale and $35 new grading costs | $258.60 | $150.50 | $108.10 |

## Grading uncertainty

Scenario weights are explicit modeling assumptions, not calibrated grading odds.
Use the cheapest configured service covering the modeled declared value. Keep
PSA and CGC costs and prices separate; do not grade an already certified card
again merely to resell it.

A missing grade price can use the documented nearest-lower observed price only
where the observed range permits that assumption. A lower-grade premium is not
a floor for an unobserved higher grade. Fully observed nonmonotonic ranges stay
usable. Downside is the worst modeled net result, not necessarily the numerically
lowest grade, and remains unknown when the evidence cannot support it.

Allocated grading shipping, service taxes, failed/no-grade outcomes, insurance,
advertising attribution and actual transit/holding time remain material inputs.
Correct arithmetic does not make those assumptions verified or guarantee resale.

## Evidence and presentation

Use actual transaction provenance and the exact card market before computing
actionable profit. The search query is a request, not observed identity. Unknown
accepted-offer amounts and unassessed raw sold conditions do not become facts
through averaging. Preserve edition, finish, language and grader/grade boundaries.

Active Buy It Now competition is labeled separately from completed sales.
The Best current buy card can show a useful comparison with a projected loss;
that is different from a verified profitable Deal. Offers remain conditional
until accepted, and an auction's profitable maximum is separate from a closing
price forecast. Use the existing offer engine and controls rather than a second
discount policy in documentation or UI.
