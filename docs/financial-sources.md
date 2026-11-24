# Pricing and financial sources

Use this reference when changing market interpretation, costs or grader rules.
Published schedules can change and do not establish this user's account terms.
Read the actual configuration in [money/config.ts](../shared/money/config.ts),
retain its verification status, and check current primary sources before replacing
an assumption. This page deliberately does not duplicate rate tables.

## Completed sales and market data

- [PKMNPrices cards](https://www.pkmnprices.com/docs/cards) and
  [sets](https://www.pkmnprices.com/docs/sets): canonical catalog candidates and
  release/collector-number context. Catalog matches do not verify a physical copy.
- [PKMNPrices eBay sold listings](https://www.pkmnprices.com/docs/ebay-listings):
  transaction type, exact/shared/unknown attribution, accepted-offer amounts,
  currency, sale dates, pagination and subsequent corrections. A stored price
  with an unknown transaction type is not necessarily the actual amount paid.
- [PKMNPrices coverage](https://www.pkmnprices.com/docs/data-coverage): market
  quotes and individual eBay transactions are different evidence.
- [PKMNPrices history and volume](https://www.pkmnprices.com/docs/price-history):
  daily price aggregates are not individual sales or a guaranteed resale speed.
- Pokémon Price Tracker supplies the app's English set-year catalog. Its graded
  sales response can also include eBay and Fanatics Collect counts by grade.
  Check the response's plan restrictions, printing, dates and transaction-level
  coverage before using it for resale. Fanatics auction prices include the
  buyer's premium. [API reference](https://www.pokemonpricetracker.com/api-reference)
  and [Fanatics coverage](https://www.pokemonpricetracker.com/fanatics-collect-pokemon-prices).
- [PKMNPrices limits](https://www.pkmnprices.com/docs/rate-limits): provider credits
  differ from returned rows, local request safeguards and AI dollars. Use response
  headers and the persistent account/search records rather than an invented cost.

Prefer the transaction's sale date for recency; ingestion and cache-read dates
cannot make an old sale recent. Corrected amounts and retractions must survive
deduplication. Asking prices, unconfirmed accepted offers and mixed printings
cannot become confirmed sold evidence through an AI guess.

## Marketplace discovery and purchase terms

- [eBay Buy APIs](https://developer.ebay.com/develop/api/buy) and
  [Browse overview](https://developer.ebay.com/api-docs/buy/api-browse.html):
  marketplace ordering, listing details, buying formats and availability.
- Lowest-price discovery and newest-first discovery are provider operations;
  sorting already-loaded rows is a separate local operation.
- Shipping quotes belong to a destination. A missing quote is not free shipping.
  Refresh current terms independently from accepted photo findings.
- A matched active listing can describe current competition or a best checked
  purchase. It does not establish an achieved sale price or time to sell.

## Selling fees and advertising

- [eBay selling fees](https://www.ebay.com/help/selling/fees/fees-sellers?id=4822)
  ([alternate fee-page URL](https://www.ebay.com/help/selling/fees-credits-invoices/selling-fees?id=4822)):
  category/account tiers, tax-inclusive transaction base and per-order fees.
- [eBay General promoted listings](https://www.ebay.com/help/selling/listings/selling-tools/promoted-listings?id=4164):
  sale attribution and the advertising fee base. A configured General ad rate
  is a modeled cost; priority advertising's click charges need a different model.

Preserve an account-backed configured rate unless current account evidence
justifies a replacement. Avoid adding a separate payment-processing fee already
included by the applicable selling schedule. The percentage base and the
per-order threshold must follow the relevant fee rules, including buyer tax.

## Grading, shipping and taxes

- [PSA TCG service levels](https://www.psacard.com/services/tcggrading) and
  [PSA trading-card services](https://www.psacard.com/services/tradingcardgrading):
  availability, declared-value coverage, service fees and turnaround estimates.
- [PSA FAQ](https://www.psacard.com/support/faq): submission/return shipping and
  rejected or non-encapsulated outcomes that can still incur a grading fee.
- [PSA tax information](https://www.psacard.com/info/tax_rates): destination-based
  grading taxes. Purchase sales tax does not automatically describe service tax.
- [CGC services and fees](https://www.cgccards.com/submit/services-fees/cgc-grading/):
  tiers, value limits, percentage charges, membership discounts and bulk terms.
- [CGC submission FAQ](https://www.cgccards.com/about/help-center-faqs/submitting-to-cgc-cards/general-submission-faqs/):
  direct-submission and account requirements.
- [CGC shipping schedule](https://www.cgcgrading.com/news/articles/shipping-collectibles-cgc-3bBipd2dAIiyJcQqJyqhzW/):
  batch size, declared value and return costs. A per-card batch allocation is
  not a verified single-card, round-trip shipping quote.

Turnaround figures are estimates. Transit, submission preparation, resale time,
service taxes and unsuccessful grading outcomes can change capital commitment.
Reselling an existing slab does not incur a new submission fee or grading delay.

## Printing and certified labels

- [PSA Pokémon basics](https://www.psacard.com/info/tcg/pokemon-basics-guide):
  Base Set printings. A normal complete PSA label must not acquire Shadowless
  prices from an unsupported artwork-border reading.
- [CGC grading scale](https://www.cgccards.uk/card-grading/grading-scale/):
  ordinary descriptive grade wording is not automatically a special qualifier.
- [Beckett scale](https://www.beckett.com/grading/scale),
  [TAG scale](https://taggrading.com/pages/scale) and
  [TAG D](https://taggrading.com/pages/tagd): existing-holder interpretation must
  preserve the actual grader, grade and meaningful label distinctions.

Grading companies and grades define different markets. Label transcription is
not external certificate verification or proof of authenticity.

## Strategy references

[PriceCharting sniping](https://www.pricecharting.com/snipe),
[subscription features](https://www.pricecharting.com/pricecharting-pro) and
[methodology](https://www.pricecharting.com/page/methodology) describe public
comparison and alert ideas, not the service's proprietary matching implementation.
Mixed grader/half-grade price buckets must not replace an exact slab market.
Price differences alone omit acquisition tax, fees, shipping and holding costs.
Daily movers, alerts and auction assistance remain subject to the
[active checklist](../LOCAL_TODO.md).
