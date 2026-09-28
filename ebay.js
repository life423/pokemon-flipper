export async function getListings(search = "") {
    const listings = [
        {
            id: "1",
            title: "1999 Pokemon Charizard Holo #4",
            currentPrice: 325,
            shipping: 5.99,
            bids: 12,
            buyingOption: "AUCTION",
            endTime: "2026-09-27T22:30:00",
            estimatedResalePrice: 500,
            image: "/images/charizard.png",
            url: "https://www.ebay.com/",
        },
        {
            id: "2",
            title: "2000 Pokemon Neo Genesis Lugia",
            currentPrice: 180,
            shipping: 4.99,
            bids: 7,
            buyingOption: "AUCTION",
            endTime: "2026-10-04T19:15:00",
            estimatedResalePrice: 300,
            image: "/images/lugia.png",
            url: "https://www.ebay.com/",
        },
    ];
  
    return listings.filter((listing) =>
      listing.title.toLowerCase().includes(search.toLowerCase())
    );
  }