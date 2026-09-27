import { renderListings } from "./listings.js";
import { calculateFlipMetrics } from "./flip.js";

const searchForm = document.querySelector("#searchForm");
const searchInput = document.querySelector("#search");
const results = document.querySelector("#results");
const sortSelect = document.querySelector("#sort");

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
    const sortedListings = sortListings(
        currentListings,
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
