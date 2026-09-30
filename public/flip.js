const TAX_RATE = 0.0825; // Temporary estimate for testing
const SELLING_FEE_RATE = 0.13; // Temporary estimate for testing
const OUTBOUND_SHIPPING = 6;

export function calculateFlipMetrics(listing) {
    // Unknown (CALCULATED) shipping counts as $0 for now.
    const subtotal = listing.currentPrice + (listing.shipping ?? 0);
    const estimatedTax = Math.round(subtotal * TAX_RATE * 100) / 100;
    const acquisitionCost = subtotal + estimatedTax;

    // Without a resale estimate there is no profit or ROI to report.
    if (listing.estimatedResalePrice == null) {
        return {
            subtotal,
            estimatedTax,
            acquisitionCost,
            estimatedSellingFees: null,
            outboundShipping: OUTBOUND_SHIPPING,
            estimatedProfit: null,
            roi: null,
        };
    }

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
