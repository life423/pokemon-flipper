import { ebayGet } from "./api.ts";
import { exclusionReason, normalizeText } from "./filters.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import type { BuyingOption, ListingSummary, Seller } from "../../shared/types.ts";

// Toys & Hobbies > Collectible Card Games > CCG Individual Cards
const CCG_INDIVIDUAL_CARDS = "183454";

// eBay's condition IDs for ungraded and graded trading cards.
const UNGRADED = "4000";
const GRADED = "2750";

// eBay's maximum page size.
const PAGE_SIZE = 200;

// eBay limits requests per day, so answers are saved. A search is saved
// briefly, since its prices move. A listing's details (photos, item
// specifics, seller) hardly change, so they're saved for a week; its
// price always comes from a search.
const SEARCH_MAX_AGE_HOURS = 10 / 60;
export const DETAILS_MAX_AGE_HOURS = 24 * 7;

// Detail requests this server has sent to eBay, for the logs.
let detailRequests = 0;

export function detailRequestCount(): number {
    return detailRequests;
}

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

export async function searchListings(
    search: string,
    { maxResults = PAGE_SIZE }: { maxResults?: number } = {}
): Promise<{ listings: ListingSummary[]; total: number }> {
    const key = `ebay:search:${maxResults}:${normalizeText(search).trim()}`;
    const saved = await readCache<{ listings: ListingSummary[]; total: number }>(key, SEARCH_MAX_AGE_HOURS);

    if (saved) return saved;

    const listings: ListingSummary[] = [];
    const seen = new Set<string>();
    let total = 0;

    for (let offset = 0; offset < maxResults; offset += PAGE_SIZE) {
        const params = new URLSearchParams({
            q: `pokemon ${search}`.trim(),
            category_ids: CCG_INDIVIDUAL_CARDS,
            filter: `buyingOptions:{AUCTION|FIXED_PRICE},conditionIds:{${UNGRADED}|${GRADED}}`,
            limit: String(PAGE_SIZE),
            offset: String(offset),
        });

        const page = await ebayGet<{ itemSummaries?: EbayItem[]; total?: number }>(
            `/buy/browse/v1/item_summary/search?${params}`
        );
        const items = page.itemSummaries ?? [];
        total = page.total ?? total;

        for (const item of items) {
            if (seen.has(item.itemId) || exclusionReason(item) !== null) continue;

            seen.add(item.itemId);
            listings.push(toListing(item));
        }

        if (items.length < PAGE_SIZE || offset + PAGE_SIZE >= total) break;
    }

    console.log(`Search ${JSON.stringify(search)}: eBay has ${total}; kept ${listings.length} single cards`);

    await writeCache(key, { listings, total });

    return { listings, total };
}

// A listing's details, saved for a week. maxAgeHours: 0 always asks eBay.
export async function getListingDetails(
    itemId: string,
    { maxAgeHours = DETAILS_MAX_AGE_HOURS }: { maxAgeHours?: number } = {}
): Promise<ListingDetails> {
    const key = `ebay:item:${itemId}`;

    if (maxAgeHours > 0) {
        const saved = await readCache<ListingDetails>(key, maxAgeHours);
        if (saved) return saved;
    }

    detailRequests += 1;
    const details = await fetchListingDetails(itemId);
    await writeCache(key, details);

    return details;
}

async function fetchListingDetails(itemId: string): Promise<ListingDetails> {
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
