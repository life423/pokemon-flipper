# Financial fee-source audit

Checked November 3, 2026 against the public primary sources linked below. This
checks published rules against `shared/money/config.ts` and the money functions;
it does not establish the user's current invoices, eligibility or tax treatment.
No paid analysis or marketplace API requests were made for this review.

## Selling fees

eBay's US no-Store schedule lists 13.25% for Collectible Card Games through
$7,500 per item, then 2.35% on the excess. The percentage base includes buyer-paid
shipping, handling and sales tax. Orders at or below $10 carry $0.30; higher orders
carry $0.40. Managed payments does not require a separate third-party processing
fee in this schedule. Account subscriptions, categories and seller performance
can change the applicable fees.
[Source: eBay selling fees](https://www.ebay.com/help/selling/fees/fees-sellers?id=4822).

The configured 13.6% is documented as transaction-backed, whereas the public
trading-card rate is 13.25%. Preserve that user configuration unless current
account evidence establishes a replacement. The configured tax-inclusive tier
and per-order threshold basis agree with the published rule for a one-item sale.
The existing model assumes the resale quote is total pre-tax revenue with
shipping included, then subtracts the seller's outbound shipping expense. It
cannot independently model an item-only resale quote plus buyer-paid shipping.

General Promoted Listings uses the ad rate on the total sale, including shipping
and taxes, subject to sale attribution. It is a sale-based charge; priority
advertising's click charges require a separate model.
[Source: eBay General campaign strategy](https://www.ebay.com/help/selling/listings/selling-tools/promoted-listings?id=4164).

**Confirmed arithmetic defect at audit start:** `ebaySellingFees` applies
`promotedRate` to `salePrice` instead of its tax-inclusive fee base. With a $100
pre-tax sale, 8% buyer tax and 5% promotion rate, the ad fee should be $5.40 rather
than $5.00. The existing default promotion rate is zero, so correcting the base
does not change unpromoted default calculations. Attribution is assumed whenever
a nonzero promotion rate is configured; this is a cost scenario, not proof that
an individual future sale will incur an ad charge.

## Direct grading service rates

The configured service fees and value limits match the following current
published US rates. Neither table includes return shipping or user-specific
taxes/discounts.

| PSA tier | Fee/card | Maximum insured value | Estimated business days |
| --- | ---: | ---: | ---: |
| Standard | $59.99 | $1,000 | 70–80 |
| Priority | $79.99 | $1,500 | 50–60 |
| Express | $199 | $2,500 | 20–30 |
| Super Express | $349 | $5,000 | 10–15 |
| Premier | $599 | $10,000 | 7–10 |

PSA currently marks Value services paused. Omitting that cheaper tier is
consistent with the page. Higher-value Premium services exist but are not
configured; the app should continue to report an unavailable path above its
configured coverage. Estimates are not guaranteed turnaround promises.
[Source: PSA TCG grading](https://www.psacard.com/services/tcggrading).

| CGC tier | Fee/card | Maximum value | Estimated working days |
| --- | ---: | ---: | ---: |
| Economy | $20 | $1,000 | 90 |
| Standard | $55 | $3,000 | 10 |
| Express | $100 | $10,000 | 5 |
| WalkThrough | $300 | $100,000 | 2 |
| Unlimited Value | $300 plus 1% of FMV | Unlimited | 2 |

The configured Unlimited Value calculation correctly **adds** the percentage to
$300; it is not the larger of $300 and 1%. Associate/Premium members receive
10% grading discounts and Elite members 20%; the app uses undiscounted fees.
Bulk requires 25 cards and is intentionally omitted. Turnarounds are estimates.
[Source: CGC Services & Fees](https://www.cgccards.com/submit/services-fees/cgc-grading/).

CGC allows direct submission with a free account; a paid membership is not a
prerequisite for the undiscounted fees.
[Source: CGC submission FAQ](https://www.cgccards.com/about/help-center-faqs/submitting-to-cgc-cards/general-submission-faqs/).

## Shipping, tax and holding-time limitations

The shared `$15` grading-shipping allowance is an assumed allocation across a
batch, not a verified one-card shipping quote. CGC's current domestic return
schedule starts at $25 for 1–5 cards with total declared value up to $5,000. That
does not include getting the raw card to CGC. For one card, the allowance is
therefore at least $10 short before inbound postage under this schedule. Shared
shipping for several cards can reduce per-card cost; submission count and value
must be known before claiming an exact total.
[Source: CGC shipping schedule](https://www.cgcgrading.com/news/articles/shipping-collectibles-cgc-3bBipd2dAIiyJcQqJyqhzW/).

PSA's return-shipping price depends on submission card count and declared value.
Service levels/submission types can require separate forms and return charges.
Its FAQ also describes some rejected/non-encapsulated outcomes that still incur
the grading fee. The current numerical-grade outlook does not model all such
outcomes.
[Source: PSA FAQ](https://www.psacard.com/support/faq).

PSA says applicable taxes depend on the return destination and are finalized
after grading. Do not apply the card-purchase tax rate to grading fees without
location-specific support, or assume grading taxes never apply.
[Source: PSA tax information](https://www.psacard.com/info/tax_rates).

The app's purchase tax, typical future buyer tax, outbound postage and grading
shipping allocation remain modeled inputs. Correct formulas do not turn these
inputs into universally verified rates. Grading turnaround plus transit and
resale time can substantially exceed a 30–60 day holding period, especially for
PSA Standard and CGC Economy. Existing slabs incur neither submission fees nor
new grading turnaround when resold as they are.

## Follow-up boundaries

- Correct the promotion fee base with an independent worked-example regression.
- Preserve the configured account-backed selling rate; keep published and
  account-specific verification distinct.
- Describe grading shipping as an allocation and obtain actual batch/return
  terms before presenting an exact submitted-card cost.
- Keep resale evidence and postage bases explicit so sold item prices are not
  accidentally treated as shipping-inclusive revenue.
- Keep turnaround, optional advertising, service taxes, failed grading outcomes,
  membership and seller-performance assumptions visible where they affect a
  decision; do not fabricate universal values for missing inputs.
