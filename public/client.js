// const searchInput = document.querySelector("#search");
//     const searchButton = document.querySelector("#searchButton");
//     const results = document.querySelector("#results");

//     searchButton.addEventListener("click", async () => {
//       const search = searchInput.value;

//       const response = await fetch(
//         `/api/listings?q=${encodeURIComponent(search)}`
//       );

//       const listings = await response.json();

//       console.log(listings);
//     });

const searchForm = document.querySelector("#searchForm");
const searchInput = document.querySelector("#search");
const results = document.querySelector("#results");

searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const search = searchInput.value;

  const response = await fetch(
    `/api/listings?q=${encodeURIComponent(search)}`
  );

  const listings = await response.json();

  console.log(listings);
});