import { calculateFlipMetrics } from "./flip.js";

const NOT_ESTIMATED = "not estimated yet";

function formatMoney(value) {
    return value === null ? null : `$${value.toFixed(2)}`;
}

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

function createLine(text) {
    const line = document.createElement("p");
    line.textContent = text;
    return line;
}

function createListingElement(listing) {
    const listingElement = document.createElement("article");

    const images = document.createElement("div");

    for (const [index, imageUrl] of listing.images.entries()) {
        const image = document.createElement("img");
        image.src = imageUrl;
        image.alt = `${listing.title} image ${index + 1}`;
        image.width = 250;
        images.append(image);
    }

    const title = document.createElement("h2");
    title.textContent = listing.title;

    const metrics = calculateFlipMetrics(listing);

    const shippingText =
        listing.shipping === null
            ? "calculated at checkout"
            : formatMoney(listing.shipping);

    const roiText =
        metrics.roi === null
            ? NOT_ESTIMATED
            : metrics.roi.toFixed(1) + "%";

    const buyingText =
        listing.buyingOption === "AUCTION"
            ? `Auction: ${listing.bids} bids`
            : "Buy It Now";

    const endingText =
        listing.endTime === null
            ? "No end date"
            : `Ends in: ${formatTimeRemaining(listing.endTime)}`;

    const link = document.createElement("a");
    link.href = listing.url;
    link.textContent = "View on eBay";
    link.target = "_blank";
    link.rel = "noopener noreferrer";

    listingElement.append(
        images,
        title,
        createLine(`Current price: ${formatMoney(listing.currentPrice) ?? "unknown"}`),
        createLine(`Shipping: ${shippingText}`),
        createLine(`Current cost before tax: ${formatMoney(metrics.subtotal)}`),
        createLine(`Estimated tax: ${formatMoney(metrics.estimatedTax)}`),
        createLine(`Estimated acquisition cost: ${formatMoney(metrics.acquisitionCost)}`),
        createLine(`Estimated resale price: ${formatMoney(listing.estimatedResalePrice) ?? NOT_ESTIMATED}`),
        createLine(`Estimated selling fees: ${formatMoney(metrics.estimatedSellingFees) ?? NOT_ESTIMATED}`),
        createLine(`Estimated outbound shipping: ${formatMoney(metrics.outboundShipping)}`),
        createLine(`Estimated profit: ${formatMoney(metrics.estimatedProfit) ?? NOT_ESTIMATED}`),
        createLine(`Estimated ROI: ${roiText}`),
        createLine(buyingText),
        createLine(endingText),
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
