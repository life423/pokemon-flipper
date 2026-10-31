# Deal alerts and saved product ideas

PriceCharting publicly describes watching newly listed/ending-soon eBay items
against market values, with minimum dollar/percentage savings, listing-type
filters, shipping adjustments and browser notifications. Wishlist alerts are
also advertised. The public documentation does not reveal the proprietary
matching implementation or promise that each apparent price difference is net
resale profit. Its public methodology combines marketplace sold data with
proprietary weighting/outlier handling; some grade buckets combine graders or
half-grades. Do not copy those mixed buckets for an exact PSA grade.

Sources: [Sniping/deal interface](https://www.pricecharting.com/snipe),
[subscription features](https://www.pricecharting.com/pricecharting-pro),
[methodology](https://www.pricecharting.com/page/methodology).

For this app, retain exact physical matching, delivered purchase cost and net
profit rather than ranking solely by percentage below a market quote. Use
deduplicated new-listing discovery and cached physical evidence. A future
watchlist would need explicit polling budgets, seen-item tracking, notification
preferences and durable jobs before unattended alerts.

Implemented in the current working tree or existing app: shortlist, selected
refresh, new-listing discovery, listing-link evaluation, flexible graded/finish
search, automatic pricing recovery, card grade/finish details, subtle motion,
observed liquidity, independent sold-copy condition grouping, broader AI
eligibility and a current graded-listing competition fallback. Consult the
pricing audit for validation limits; discussion is not release proof.

Still proposals: market history charts and predictive up/down scoring (the user
explicitly said later), continuous saved-search alerts, budget-guided next-flip
recommendations, and public paid-user accounts/credits/payments. No forecast,
unattended notifications or public payment system was implemented in this audit.
