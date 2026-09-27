const TAX_RATE = 0.0825; // Temporary estimate for testing
const SELLING_FEE_RATE = 0.13; // Temporary test estimate
const OUTBOUND_SHIPPING = 6;

function formatTimeRemaining(endTime) {
    const end = new Date(endTime);
    const now = new Date();

    const millisecondsRemaining = end - now;

    if (millisecondsRemaining <= 0) {
        return "Ended";
    }

    const totalMinutes = Math.floor(millisecondsRemaining / 1000 / 60);

    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;

    if (days > 0) {
        return `${days}d ${hours}h ${minutes}m`;
    }

    return `${hours}h ${minutes}m`;
}

function createListingElement(listing) {
    const listingElement = document.createElement("article");

    const image = document.createElement("img");
    image.src = listing.image;
    image.alt = listing.title;
    image.width = 250;

    const title = document.createElement("h2");
    title.textContent = listing.title;

    const price = document.createElement("p");
    price.textContent = `Current price: $${listing.currentPrice.toFixed(2)}`;

    const shipping = document.createElement("p");
    shipping.textContent = `Shipping: $${listing.shipping.toFixed(2)}`;

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

    const currentCost = document.createElement("p");
    currentCost.textContent =
        `Current cost before tax: $${subtotal.toFixed(2)}`;

    const tax = document.createElement("p");
    tax.textContent =
        `Estimated tax: $${estimatedTax.toFixed(2)}`;

    const acquisition = document.createElement("p");
    acquisition.textContent =
        `Estimated acquisition cost: $${acquisitionCost.toFixed(2)}`;

    const resalePrice = document.createElement("p");
    resalePrice.textContent =
        `Estimated resale price: $${listing.estimatedResalePrice.toFixed(2)}`;

    const sellingFees = document.createElement("p");
    sellingFees.textContent =
        `Estimated selling fees: $${estimatedSellingFees.toFixed(2)}`;

    const profit = document.createElement("p");
    profit.textContent =
        `Estimated profit: $${estimatedProfit.toFixed(2)}`;

    const bids = document.createElement("p");
    bids.textContent = `Bids: ${listing.bids}`;

    const ending = document.createElement("p");
    ending.textContent = `Ends in: ${formatTimeRemaining(listing.endTime)}`;

    const link = document.createElement("a");
    link.href = listing.url;
    link.textContent = "View on eBay";
    link.target = "_blank";
    link.rel = "noopener noreferrer";

    listingElement.append(
        image,
        title,
        price,
        shipping,
        currentCost,
        tax,
        acquisition,
        resalePrice,
        sellingFees,
        profit,
        bids,
        ending,
        link
    );

    return listingElement;
}

export function renderListings(listings, results) {
    results.replaceChildren();

    if (listings.length === 0) {
        results.textContent = "No listings found.";
        return;
    }

    for (const listing of listings) {
        results.append(createListingElement(listing));
    }
}
