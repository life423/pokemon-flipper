import { exclusionReason } from "./listing-filters.js";

// eBay Browse API: reads public listings with an application
// token (client credentials). No eBay user ever signs in.
const EBAY_API = "https://api.ebay.com";

// Toys & Hobbies > Collectible Card Games > CCG Individual Cards
const CCG_INDIVIDUAL_CARDS = "183454";

// eBay's condition ID for ungraded trading cards.
const UNGRADED = "4000";

// eBay's condition ID for graded trading cards.
const GRADED = "2750";

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
    if (cachedToken && Date.now() < tokenExpiresAt) {
        return cachedToken;
    }

    const credentials = Buffer.from(
        `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
    ).toString("base64");

    const response = await fetch(`${EBAY_API}/identity/v1/oauth2/token`, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${credentials}`,
        },
        body: new URLSearchParams({
            grant_type: "client_credentials",
            scope: "https://api.ebay.com/oauth/api_scope",
        }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(
            `eBay token request failed (${response.status}): ${data.error_description ?? data.error ?? "unknown error"}`
        );
    }

    cachedToken = data.access_token;

    // Tokens last 2 hours. Refresh a minute early so one never
    // expires in the middle of a request.
    tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;

    return cachedToken;
}

async function ebayGet(path) {
    const token = await getAccessToken();

    const headers = {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    };

    // Optional: lets eBay quote CALCULATED shipping to your ZIP.
    if (process.env.EBAY_SHIP_TO_ZIP) {
        headers["X-EBAY-C-ENDUSERCTX"] =
            `contextualLocation=country%3DUS%2Czip%3D${process.env.EBAY_SHIP_TO_ZIP}`;
    }

    const response = await fetch(`${EBAY_API}${path}`, { headers });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        const error = new Error(
            `eBay request failed (${response.status}): ${data.errors?.[0]?.message ?? "unknown error"}`
        );
        error.status = response.status;
        throw error;
    }

    return data;
}

function toAmount(price) {
    return price ? Number(price.value) : null;
}

function toListing(item) {
    const isAuction = item.buyingOptions?.includes("AUCTION") ?? false;
    const shippingOption = item.shippingOptions?.[0];

    return {
        id: item.itemId,
        title: item.title,
        // Auctions report the current bid; fixed-price listings report price.
        currentPrice: toAmount(
            isAuction ? item.currentBidPrice ?? item.price : item.price
        ),
        // null when shipping is CALCULATED and eBay has no ship-to ZIP.
        shipping: toAmount(shippingOption?.shippingCost),
        bids: item.bidCount ?? 0,
        isGraded: item.conditionId === GRADED,
        buyingOption: isAuction ? "AUCTION" : "FIXED_PRICE",
        // Fixed-price listings usually have no end date.
        endTime: item.itemEndDate ?? null,
        // No pricing source yet, so no resale estimate.
        estimatedResalePrice: null,
        images: [
            item.image?.imageUrl,
            ...(item.additionalImages ?? []).map((image) => image.imageUrl),
        ].filter(Boolean),
        url: item.itemWebUrl,
    };
}

export async function getListings(search = "") {
    const params = new URLSearchParams({
        q: `pokemon ${search}`.trim(),
        category_ids: CCG_INDIVIDUAL_CARDS,
        filter: `buyingOptions:{AUCTION|FIXED_PRICE},conditionIds:{${UNGRADED}|${GRADED}}`,
        // eBay's maximum. Screening drops some, so start with plenty.
        limit: "200",
    });

    const data = await ebayGet(`/buy/browse/v1/item_summary/search?${params}`);
    const items = data.itemSummaries ?? [];
    const kept = items.filter((item) => exclusionReason(item, search) === null);

    console.log(
        `Search ${JSON.stringify(search)}: kept ${kept.length} of ${items.length} listings`
    );

    return kept.map(toListing);
}

// What buying it costs right now: the current bid for an auction, the
// price otherwise, and the quoted shipping (null when not quoted).
function priceDetails(item) {
    const isAuction = item.buyingOptions?.includes("AUCTION") ?? false;

    return {
        price: toAmount(isAuction ? item.currentBidPrice ?? item.price : item.price),
        shipping: toAmount(item.shippingOptions?.[0]?.shippingCost),
        buyingOption: isAuction ? "AUCTION" : "FIXED_PRICE",
        bids: item.bidCount ?? 0,
        endTime: item.itemEndDate ?? null,
    };
}

// Full details for analysis: full-size photos, plus the seller's
// item specifics (set, card number, finish, and so on).
export async function getListingDetails(itemId) {
    const item = await ebayGet(
        `/buy/browse/v1/item/${encodeURIComponent(itemId)}`
    );

    return {
        id: item.itemId,
        title: item.title,
        condition: item.condition ?? null,
        ...priceDetails(item),
        aspects: Object.fromEntries(
            (item.localizedAspects ?? []).map((aspect) => [
                aspect.name,
                aspect.value,
            ])
        ),
        images: [
            item.image?.imageUrl,
            ...(item.additionalImages ?? []).map((image) => image.imageUrl),
        ].filter(Boolean),
        url: item.itemWebUrl,
    };
}
