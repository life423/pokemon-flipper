const TAX_RATE = 0.0825; // Temporary estimate for testing
const SELLING_FEE_RATE = 0.13; // Temporary estimate for testing
const OUTBOUND_SHIPPING = 6;

export function calculateFlipMetrics(listing) {
    const subtotal = listing.currentPrice + listing.shipping;
    const estimatedTax = Math.round(subtotal * TAX_RATE * 100) / 100;
    const acquisitionCost = subtotal + estimatedTax;

    const estimatedSellingFees =
        listing.estimatedResalePrice * SELLING_FEE_RATE;

    const estimatedProfit =
        listing.estimatedResalePrice -
        estimatedSellingFees -
        OUTBOUND_SHIPPING -
        acquisitionCost;

    const roi = (estimatedProfit / acquisitionCost) * 100;

    return {
        subtotal,
        estimatedTax,
        acquisitionCost,
        estimatedSellingFees,
        outboundShipping: OUTBOUND_SHIPPING,
        estimatedProfit,
        roi,
    };
}
