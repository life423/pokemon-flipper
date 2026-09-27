import { renderListings } from "./listings.js";

const searchForm = document.querySelector("#searchForm");
const searchInput = document.querySelector("#search");
const results = document.querySelector("#results");

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

        const listings = await response.json();

        renderListings(listings, results);
    } catch (error) {
        console.error(error);
        results.textContent = "Something went wrong while searching.";
    }
});
