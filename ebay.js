export async function getListings(search = "") {
    const listings = [
        {
            title: "1999 Pokemon Charizard Holo #4",
            price: 325,
            shipping: 5.99,
            bids: 12,
            image: "/images/charizard.png",
            url: "https://www.ebay.com/",
        },
        {
            title: "2000 Pokemon Neo Genesis Lugia",
            price: 180,
            shipping: 4.99,
            bids: 7,
            image: "/images/lugia.png",
            url: "https://www.ebay.com/",
        },
    ];
  
    return listings.filter((listing) =>
      listing.title.toLowerCase().includes(search.toLowerCase())
    );
  }