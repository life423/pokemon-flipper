import { ebayGet, EbayError } from "./api.ts";
import { exclusionReason, normalizeText } from "./filters.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { ebayUsage, EbayBudgetError } from "./usage.ts";
import { createSingleFlight } from "../lib/single-flight.ts";
import { photoEvidenceKey, searchPhotosFitDetails } from "../../shared/listing-evidence.ts";
import type { BuyingOption, ListingSummary, Seller } from "../../shared/types.ts";
import type { ListingFilters } from "../../shared/listing-filters.ts";
import { cardLanguageStatus, EnglishOnlyError } from "../../shared/card-language.ts";

// Toys & Hobbies > Collectible Card Games > CCG Individual Cards
export const CCG_INDIVIDUAL_CARDS = "183454";

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
const shareDetails = createSingleFlight();

// Quotes are destination-specific. Adding/changing a ZIP must not reuse a
// quote (or a missing quote) fetched for another destination.
export function shippingCacheScope(): string {
    const zip = process.env.EBAY_SHIP_TO_ZIP?.trim();
    return zip ? `:ship-to:${encodeURIComponent(zip)}` : "";
}
export const listingCacheKey = (itemId: string) => `ebay:item:${itemId}${shippingCacheScope()}`;

export function detailRequestCount(): number {
    return detailRequests;
}

interface Amount {
    value: string;
    currency: string;
}

// The parts of an eBay item this app reads, from search or getItem.
interface EbayItem {
    estimatedAvailabilities?: { estimatedAvailabilityStatus?: string }[];
    itemId: string;
    title: string;
    itemWebUrl: string;
    itemGroupType?: string;
    buyingOptions?: string[];
    price?: Amount;
    currentBidPrice?: Amount;
    bidCount?: number;
    itemEndDate?: string;
    itemOriginDate?: string;
    itemCreationDate?: string;
    conditionId?: string;
    condition?: string;
    image?: { imageUrl: string };
    additionalImages?: { imageUrl: string }[];
    shippingOptions?: { shippingCost?: Amount }[];
    categories?: { categoryId: string }[];
    seller?: { username?: string; feedbackPercentage?: string; feedbackScore?: number };
    localizedAspects?: { name: string; value: string }[];
    conditionDescriptors?: { name: string; values?: { content: string; additionalInfo?: string[] }[] }[];
}

// Full details for analysis.
export interface ListingDetails {
    listedAt?: string | null;
    createdAt?: string | null;
    itemGroupType?: string;
    retrievedAt?: string;
    availability?: "ACTIVE" | "UNAVAILABLE" | "UNKNOWN";
    bestOffer?: boolean;
    // Search snapshot used to validate this cache without requesting eBay again.
    searchPhotoKey?: string;
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
    if (!amount || amount.currency !== "USD" || typeof amount.value !== "string" || !amount.value.trim()) return null;
    const value = Number(amount.value);
    return Number.isFinite(value) && value >= 0 ? value : null;
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

function listingDates(item: EbayItem) {
    const validDate = (value: unknown): string | null => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
    const listedAt = validDate(item.itemOriginDate);
    const createdAt = validDate(item.itemCreationDate);
    // First available to buy and created can differ; never substitute one for
    // the other or use our retrieval time to make old inventory look new.
    return { ...(listedAt ? { listedAt } : {}), ...(createdAt ? { createdAt } : {}) };
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
        bestOffer: item.buyingOptions?.includes("BEST_OFFER") ?? false,
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
        ...listingDates(item),
        isGraded: item.conditionId === GRADED,
        bestOffer: item.buyingOptions?.includes("BEST_OFFER") ?? false,
        categoryId: item.categories?.[0]?.categoryId,
        seller: toSeller(item.seller),
        images: photosOf(item),
        url: item.itemWebUrl,
    };
}

export async function searchListings(
    search: string,
    {
        maxResults = PAGE_SIZE,
        anyCategory = false,
        keepReserve = false,
        signal,
        sort,
        filters,
        auctionEndsWithinHours,
        asOf = Date.now(),
    }: { maxResults?: number; anyCategory?: boolean; keepReserve?: boolean; signal?: AbortSignal; sort?: "newlyListed" | "price"; filters?: ListingFilters; auctionEndsWithinHours?: number; asOf?: number } = {}
): Promise<{ listings: ListingSummary[]; total: number; skipped: number }> {
    if (cardLanguageStatus(search) === "OTHER") throw new EnglishOnlyError();
    const scope = anyCategory ? "any" : "cards";
    signal?.throwIfAborted();
    const buyingOption = filters?.typeFilter && filters.typeFilter !== "all" ? filters.typeFilter : undefined;
    const kind = filters?.kindFilter && filters.kindFilter !== "all" ? filters.kindFilter : undefined;
    const endWindow = buyingOption === "AUCTION" && typeof auctionEndsWithinHours === "number" && Number.isFinite(auctionEndsWithinHours) && auctionEndsWithinHours > 0 ? auctionEndsWithinHours : undefined;
    const filterScope = buyingOption || kind || endWindow ? `:filters:${JSON.stringify([buyingOption ?? null, kind ?? null, endWindow ?? null])}` : "";
    const key = `ebay:search:${maxResults}:${scope}:language:en:${sort ? `${sort}:` : ""}${normalizeText(search).trim()}${shippingCacheScope()}${filterScope}`;
    const saved = await readCache<{ listings: ListingSummary[]; total: number; skipped: number }>(key, sort ? 1 / 60 : SEARCH_MAX_AGE_HOURS);
    signal?.throwIfAborted();

    if (saved) return saved;

    // The few search requests are refused only when the day's allowance is gone.
    const usage = await ebayUsage();

    if (usage && usage.remaining < Math.ceil(maxResults / PAGE_SIZE)) {
        throw new EbayBudgetError("eBay's daily limit is used up. It resets at midnight Pacific.");
    }

    const listings: ListingSummary[] = [];
    const seen = new Set<string>();
    let total = 0;
    // Junk the free rules dropped: lots, sealed product, merch, fakes.
    let skipped = 0;
    const sourceNow = asOf;

    for (let offset = 0; offset < maxResults; offset += PAGE_SIZE) {
        signal?.throwIfAborted();
        if (keepReserve && (await ebayUsage())?.braking) {
            throw new EbayBudgetError("Saving the rest of today's eBay allowance; extra searches paused.");
        }
        const filter = [`buyingOptions:{${buyingOption ?? "AUCTION|FIXED_PRICE"}}`, `conditionIds:{${kind === "raw" ? UNGRADED : kind === "graded" ? GRADED : `${UNGRADED}|${GRADED}`}}`];
        if (endWindow) filter.push(`itemEndDate:[${new Date(sourceNow).toISOString()}..${new Date(sourceNow + endWindow * 3600000).toISOString()}]`);
        const params = new URLSearchParams({
            q: `pokemon ${search}${anyCategory ? " english" : ""}`.trim(),
            // Outside the card category, for listings filed in the wrong one.
            ...(anyCategory ? {} : { category_ids: CCG_INDIVIDUAL_CARDS, aspect_filter: `categoryId:${CCG_INDIVIDUAL_CARDS},Language:{English}` }),
            filter: filter.join(","),
            limit: String(PAGE_SIZE),
            offset: String(offset),
            ...(sort ? { sort } : {}),
        });

        const page = await ebayGet<{ itemSummaries?: EbayItem[]; total?: number }>(
            `/buy/browse/v1/item_summary/search?${params}`, { signal, keepReserve }
        );
        signal?.throwIfAborted();
        const items = page.itemSummaries ?? [];
        total = page.total ?? total;

        for (const item of items) {
            if (seen.has(item.itemId)) continue;

            if (exclusionReason(item) !== null || cardLanguageStatus(item.title, item.localizedAspects?.filter(aspect => aspect.name.toLowerCase() === "language").map(aspect => aspect.value)) === "OTHER") {
                skipped += 1;
                continue;
            }

            seen.add(item.itemId);
            listings.push(toListing(item));
        }

        if (items.length < PAGE_SIZE || offset + PAGE_SIZE >= total) break;
    }

    console.log(`Search ${JSON.stringify(search)}: eBay has ${total}; kept ${listings.length} single cards`);

    await writeCache(key, { listings, total, skipped });

    return { listings, total, skipped };
}

// A listing's details, saved for a week. maxAgeHours: 0 always asks eBay.
// keepReserve: refuse to ask eBay once the day's allowance is in reserve
// (the free check's bulk lookups); a deliberate analysis still asks.
export async function getListingDetails(
    itemId: string,
    { maxAgeHours = DETAILS_MAX_AGE_HOURS, keepReserve = false, expectedPhotos, expectedTitle, allowEndedCache = false }: {
        maxAgeHours?: number; keepReserve?: boolean; expectedPhotos?: readonly string[]; expectedTitle?: string; allowEndedCache?: boolean;
    } = {}
): Promise<ListingDetails> {
    const key = listingCacheKey(itemId);

    if (maxAgeHours > 0) {
        const saved = await readCache<ListingDetails>(key, maxAgeHours);
        if (saved && (allowEndedCache || saved.availability !== "UNAVAILABLE" || await readCache(key, 1 / 60)) && (expectedTitle === undefined || expectedTitle.trim() === saved.title.trim()) &&
            (expectedPhotos === undefined || (saved.searchPhotoKey !== undefined
                ? saved.searchPhotoKey === photoEvidenceKey(expectedPhotos)
                : searchPhotosFitDetails(expectedPhotos, saved.images)))) {
            if (expectedPhotos !== undefined && saved.searchPhotoKey === undefined) {
                saved.searchPhotoKey = photoEvidenceKey(expectedPhotos);
                await writeCache(key, saved);
            }
            return saved;
        }
    }

    if (keepReserve && (await ebayUsage())?.braking) {
        throw new EbayBudgetError("Saving the rest of today's eBay allowance.");
    }

    const evidence = expectedPhotos === undefined ? "" : photoEvidenceKey(expectedPhotos);
    return shareDetails(JSON.stringify([itemId, expectedTitle, evidence]), async () => {
        detailRequests += 1;
        let details: ListingDetails;
        try { details = await fetchListingDetails(itemId, keepReserve); }
        catch (error) {
            if (error instanceof EbayError && [404, 410].includes(error.status)) {
                const previous = await readCache<ListingDetails>(key, DETAILS_MAX_AGE_HOURS);
                if (previous) await writeCache(key, { ...previous, availability: "UNAVAILABLE" }).catch(() => {});
            }
            throw error;
        }
        if (expectedPhotos !== undefined) details.searchPhotoKey = evidence;
        await writeCache(key, details);
        return details;
    });
}

async function fetchListingDetails(itemId: string, keepReserve = false): Promise<ListingDetails> {
    const item = await ebayGet<EbayItem>(`/buy/browse/v1/item/${encodeURIComponent(itemId)}`, { keepReserve });
    const descriptors = item.conditionDescriptors ?? [];

    // eBay's structured condition fields, as item specifics.
    const conditionFields: Record<string, string> = {};
    for (const descriptor of descriptors) {
        const content = descriptor.values?.[0]?.content;
        if (content) conditionFields[descriptor.name] = content;
    }

    return {
        retrievedAt: new Date().toISOString(),
        itemGroupType: item.itemGroupType,
        availability: item.itemEndDate && Date.parse(item.itemEndDate) <= Date.now() || item.estimatedAvailabilities?.some((entry) => entry.estimatedAvailabilityStatus === "OUT_OF_STOCK")
            ? "UNAVAILABLE" : item.estimatedAvailabilities?.some((entry) => ["IN_STOCK", "LIMITED_STOCK"].includes(entry.estimatedAvailabilityStatus ?? "")) ? "ACTIVE" : "UNKNOWN",
        id: item.itemId,
        title: item.title,
        url: item.itemWebUrl,
        images: photosOf(item),
        ...priceDetails(item),
        ...listingDates(item),
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
