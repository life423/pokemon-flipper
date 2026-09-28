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

function sortListings(listings, sortBy) {
    const sortedListings = [...listings];

    if (sortBy === "profit") {
        sortedListings.sort((a, b) => {
            return (
                calculateFlipMetrics(b).estimatedProfit -
                calculateFlipMetrics(a).estimatedProfit
            );
        });
    }

    if (sortBy === "roi") {
        sortedListings.sort((a, b) => {
            return (
                calculateFlipMetrics(b).roi -
                calculateFlipMetrics(a).roi
            );
        });
    }

    if (sortBy === "price") {
        sortedListings.sort(
            (a, b) => a.currentPrice - b.currentPrice
        );
    }

    if (sortBy === "ending") {
        sortedListings.sort(
            (a, b) => new Date(a.endTime) - new Date(b.endTime)
        );
    }

    return sortedListings;
}

function renderSortedListings() {
    const minimumRoi = Number(minRoiInput.value) || 0;

    const minimumCost =
        minCostInput.value === ""
            ? 0
            : Number(minCostInput.value);

    const maximumCost =
        maxCostInput.value === ""
            ? Infinity
            : Number(maxCostInput.value);

    const minimumProfit =
        minProfitInput.value === ""
            ? 0
            : Number(minProfitInput.value);

    const filteredListings = currentListings.filter((listing) => {
        const metrics = calculateFlipMetrics(listing);

        const isActive =
            new Date(listing.endTime) > new Date();

        const meetsRoi =
            metrics.roi >= minimumRoi;

        const meetsMinimumCost =
            metrics.acquisitionCost >= minimumCost;

        const meetsMaximumCost =
            metrics.acquisitionCost <= maximumCost;

        const meetsMinimumProfit =
            metrics.estimatedProfit >= minimumProfit;

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
