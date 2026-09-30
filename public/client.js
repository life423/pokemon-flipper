import { renderListings } from "./listings.js";
import { calculateFlipMetrics } from "./flip.js";

const searchForm = document.querySelector("#searchForm");
const searchInput = document.querySelector("#search");
const results = document.querySelector("#results");
const sortSelect = document.querySelector("#sort");
const minRoiInput = document.querySelector("#minRoi");
const minCostInput = document.querySelector("#minCost");
const maxCostInput = document.querySelector("#maxCost");
const minProfitInput = document.querySelector("#minProfit");

let currentListings = [];

// Unknown values (null) always sort to the bottom, in either direction.
function compareNullsLast(a, b, direction) {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;

    return direction === "ascending" ? a - b : b - a;
}

function toTimestamp(endTime) {
    return endTime === null ? null : new Date(endTime).getTime();
}

function sortListings(listings, sortBy) {
    const sortedListings = [...listings];

    if (sortBy === "profit") {
        sortedListings.sort((a, b) =>
            compareNullsLast(
                calculateFlipMetrics(a).estimatedProfit,
                calculateFlipMetrics(b).estimatedProfit,
                "descending"
            )
        );
    }

    if (sortBy === "roi") {
        sortedListings.sort((a, b) =>
            compareNullsLast(
                calculateFlipMetrics(a).roi,
                calculateFlipMetrics(b).roi,
                "descending"
            )
        );
    }

    if (sortBy === "price") {
        sortedListings.sort((a, b) =>
            compareNullsLast(a.currentPrice, b.currentPrice, "ascending")
        );
    }

    if (sortBy === "ending") {
        sortedListings.sort((a, b) =>
            compareNullsLast(
                toTimestamp(a.endTime),
                toTimestamp(b.endTime),
                "ascending"
            )
        );
    }

    return sortedListings;
}

// An empty filter box means no filter at all.
function readFilter(input) {
    return input.value === "" ? null : Number(input.value);
}

function renderSortedListings() {
    const minimumRoi = readFilter(minRoiInput);
    const minimumCost = readFilter(minCostInput);
    const maximumCost = readFilter(maxCostInput);
    const minimumProfit = readFilter(minProfitInput);

    const filteredListings = currentListings.filter((listing) => {
        const metrics = calculateFlipMetrics(listing);

        // Fixed-price listings usually have no end date.
        const isActive =
            listing.endTime === null ||
            new Date(listing.endTime) > new Date();

        // A filter you set only passes listings that provably meet it,
        // so listings without a resale estimate drop out of the ROI
        // and profit filters.
        const meetsRoi =
            minimumRoi === null ||
            (metrics.roi !== null && metrics.roi >= minimumRoi);

        const meetsMinimumCost =
            minimumCost === null ||
            metrics.acquisitionCost >= minimumCost;

        const meetsMaximumCost =
            maximumCost === null ||
            metrics.acquisitionCost <= maximumCost;

        const meetsMinimumProfit =
            minimumProfit === null ||
            (metrics.estimatedProfit !== null &&
                metrics.estimatedProfit >= minimumProfit);

        return (
            isActive &&
            meetsRoi &&
            meetsMinimumCost &&
            meetsMaximumCost &&
            meetsMinimumProfit
        );
    });

    const sortedListings = sortListings(
        filteredListings,
        sortSelect.value
    );

    renderListings(sortedListings, results);
}

searchForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const search = searchInput.value;

    try {
        results.textContent = "Searching...";

        const response = await fetch(
            `/api/listings?q=${encodeURIComponent(search)}`
        );

        if (!response.ok) {
            throw new Error("Search request failed");
        }

        currentListings = await response.json();

        renderSortedListings();
    } catch (error) {
        console.error(error);
        results.textContent = "Something went wrong while searching.";
    }
});

sortSelect.addEventListener("change", () => {
    renderSortedListings();
});

minRoiInput.addEventListener("input", () => {
    renderSortedListings();
});

minCostInput.addEventListener("input", () => {
    renderSortedListings();
});

maxCostInput.addEventListener("input", () => {
    renderSortedListings();
});

minProfitInput.addEventListener("input", () => {
    renderSortedListings();
});
