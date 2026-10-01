import { ebayGet } from "./api.ts";
import { exclusionReason } from "./filters.ts";
import type { BuyingOption, ListingSummary, Seller } from "../../shared/types.ts";

// Toys & Hobbies > Collectible Card Games > CCG Individual Cards
const CCG_INDIVIDUAL_CARDS = "183454";

// eBay's condition IDs for ungraded and graded trading cards.
const UNGRADED = "4000";
const GRADED = "2750";

interface Amount {
    value: string;
    currency: string;
}

// The parts of an eBay item this app reads, from search or getItem.
interface EbayItem {
    itemId: string;
    title: string;
    itemWebUrl: string;
    itemGroupType?: string;
    buyingOptions?: string[];
    price?: Amount;
    currentBidPrice?: Amount;
    bidCount?: number;
    itemEndDate?: string;
    conditionId?: string;
    condition?: string;
    image?: { imageUrl: string };
    additionalImages?: { imageUrl: string }[];
    shippingOptions?: { shippingCost?: Amount }[];
    seller?: { username?: string; feedbackPercentage?: string; feedbackScore?: number };
    localizedAspects?: { name: string; value: string }[];
    conditionDescriptors?: { name: string; values?: { content: string; additionalInfo?: string[] }[] }[];
}

// Full details for analysis.
export interface ListingDetails {
    id: string;
    title: string;
    url: string;
    images: string[];
    price: number | null;
    // null when shipping is CALCULATED and eBay has no ship-to ZIP.
    shipping: number | null;
    buyingOption: BuyingOption;
    bids: number;
    endTime: string | null;
    seller: Seller | null;
    // eBay's condition: "Ungraded" or "Graded".
    condition: string | null;
    // The seller's card condition for a raw card, and its notes.
    cardCondition: string | null;
    conditionNotes: string[];
    // Item specifics, plus eBay's structured grader, grade, and cert.
    aspects: Record<string, string>;
}

function toAmount(amount: Amount | undefined): number | null {
    return amount ? Number(amount.value) : null;
}

function toSeller(seller: EbayItem["seller"]): Seller | null {
    if (!seller) return null;

    return {
        username: seller.username ?? null,
        feedbackPercentage: seller.feedbackPercentage == null ? null : Number(seller.feedbackPercentage),
        feedbackScore: seller.feedbackScore ?? null,
    };
}

function photosOf(item: EbayItem): string[] {
    return [item.image?.imageUrl, ...(item.additionalImages ?? []).map((image) => image.imageUrl)].filter(
        (url): url is string => Boolean(url)
    );
}

// What buying it costs right now: the current bid for an auction, the
// price otherwise, and the quoted shipping.
function priceDetails(item: EbayItem) {
    const isAuction = item.buyingOptions?.includes("AUCTION") ?? false;
    const buyingOption: BuyingOption = isAuction ? "AUCTION" : "FIXED_PRICE";

    return {
        price: toAmount(isAuction ? (item.currentBidPrice ?? item.price) : item.price),
        shipping: toAmount(item.shippingOptions?.[0]?.shippingCost),
        buyingOption,
        bids: item.bidCount ?? 0,
        // Fixed-price listings usually have no end date.
        endTime: item.itemEndDate ?? null,
    };
}

function toListing(item: EbayItem): ListingSummary {
    const { price, ...rest } = priceDetails(item);

    return {
        id: item.itemId,
        title: item.title,
        currentPrice: price,
        ...rest,
        isGraded: item.conditionId === GRADED,
        seller: toSeller(item.seller),
        images: photosOf(item),
        url: item.itemWebUrl,
    };
}

export async function getListings(search = ""): Promise<ListingSummary[]> {
    const params = new URLSearchParams({
        q: `pokemon ${search}`.trim(),
        category_ids: CCG_INDIVIDUAL_CARDS,
        filter: `buyingOptions:{AUCTION|FIXED_PRICE},conditionIds:{${UNGRADED}|${GRADED}}`,
        // eBay's maximum. Screening drops some, so start with plenty.
        limit: "200",
    });

    const data = await ebayGet<{ itemSummaries?: EbayItem[] }>(`/buy/browse/v1/item_summary/search?${params}`);
    const items = data.itemSummaries ?? [];
    const kept = items.filter((item) => exclusionReason(item, search) === null);

    console.log(`Search ${JSON.stringify(search)}: kept ${kept.length} of ${items.length} listings`);

    return kept.map(toListing);
}

export async function getListingDetails(itemId: string): Promise<ListingDetails> {
    const item = await ebayGet<EbayItem>(`/buy/browse/v1/item/${encodeURIComponent(itemId)}`);
    const descriptors = item.conditionDescriptors ?? [];

    // eBay's structured condition fields, as item specifics.
    const conditionFields: Record<string, string> = {};
    for (const descriptor of descriptors) {
        const content = descriptor.values?.[0]?.content;
        if (content) conditionFields[descriptor.name] = content;
    }

    return {
        id: item.itemId,
        title: item.title,
        url: item.itemWebUrl,
        images: photosOf(item),
        ...priceDetails(item),
        seller: toSeller(item.seller),
        condition: item.condition ?? null,
        cardCondition: conditionFields["Card Condition"] ?? null,
        conditionNotes: descriptors.flatMap((descriptor) =>
            (descriptor.values ?? []).flatMap((value) => value.additionalInfo ?? [])
        ),
        aspects: {
            ...Object.fromEntries((item.localizedAspects ?? []).map((aspect) => [aspect.name, aspect.value])),
            ...conditionFields,
        },
    };
}
