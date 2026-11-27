import { configuredShippingZip, ebayGet, EbayError } from "./api.ts";
import { withShippingDestination } from "./shipping-destination.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { ebayUsage, EbayBudgetError } from "./usage.ts";
import { createSharedWork } from "../lib/shared-work.ts";
import { photoEvidenceKey, searchPhotosFitDetails } from "../../shared/listing-evidence.ts";
import type { BuyingOption, Seller } from "../../shared/types.ts";
import { money } from "../../shared/money.ts";
import { cardSpecificNotes, hasSavedConditionExamples } from "../../shared/ebay-condition-notes.ts";

// Preserve the existing cache lifetime and destination-specific keys.
export const DETAILS_MAX_AGE_HOURS = 24 * 7;

const shareDetails = createSharedWork();

// Quotes are destination-specific. Adding/changing a ZIP must not reuse a
// quote (or a missing quote) fetched for another destination.
export function shippingCacheScope(): string {
    const zip = configuredShippingZip();
    return zip ? `:ship-to:${encodeURIComponent(zip)}` : "";
}
export const listingCacheKey = (itemId: string, shippingScope = shippingCacheScope()) => `ebay:item:${itemId}${shippingScope}`;

// The item's legacy cache key already encoded the destination used to quote it.
// Reattach it on read so the accepted quote can still be used for that ZIP.
function cachedShippingDestination<T extends { shippingDestination?: string | null }>(listing: T): T {
    return listing.shippingDestination === undefined ? { ...listing, shippingDestination: configuredShippingZip() } : listing;
}

interface Amount {
    value: string;
    currency: string;
    convertedFromCurrency?: string;
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
    minimumPriceToBid?: Amount;
    bidCount?: number;
    itemEndDate?: string;
    itemOriginDate?: string;
    itemCreationDate?: string;
    conditionId?: string;
    condition?: string;
    conditionDescription?: string;
    description?: string;
    image?: { imageUrl: string };
    additionalImages?: { imageUrl: string }[];
    shippingOptions?: { shippingCost?: Amount; shippingCostType?: string;
        shipToLocationUsedForEstimate?: { country?: string; postalCode?: string } }[];
    categories?: { categoryId: string }[];
    seller?: { username?: string; feedbackPercentage?: string; feedbackScore?: number };
    localizedAspects?: { name: string; value: string }[];
    conditionDescriptors?: { name: string; values?: { content: string; additionalInfo?: string[] }[] }[];
}

// Full details for analysis.
export interface ListingDetails {
    shippingDestination?: string | null;
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
    auctionBids?: { currentBid: number | null; minimumBid: number | null };
    // null when eBay does not supply a usable delivery quote.
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

export function quotedShipping(item: Pick<EbayItem, "shippingOptions">): number | null {
    const zip = configuredShippingZip();
    for (const option of item.shippingOptions ?? []) {
        if (option.shippingCostType === "CALCULATED" && !zip) continue;
        const destination = option.shipToLocationUsedForEstimate;
        if (destination?.country && destination.country !== "US") continue;
        const quotedZip = destination?.postalCode?.split("-")[0];
        // eBay can mask digits in the echoed postal code.
        if (quotedZip && (!zip || quotedZip.length !== 5 || ![...quotedZip].every((digit, index) => digit === "*" || digit === zip[index]))) continue;
        const amount = toAmount(option.shippingCost);
        if (amount !== null) return amount;
    }
    return null;
}

// eBay sets the opening minimum even before the first bid. On mixed-format
// auctions the ordinary price can be the Buy It Now price.
export function auctionBidTerms(item: Pick<EbayItem, "currentBidPrice" | "minimumPriceToBid" | "bidCount">) {
    const nativeBid = (amount?: Amount) => {
        if (amount?.convertedFromCurrency && amount.convertedFromCurrency !== "USD") return null;
        const price = toAmount(amount);
        return price !== null && price > 0 && money(price) === price ? price : null;
    };
    return {
        currentBid: item.bidCount === 0 ? null : nativeBid(item.currentBidPrice),
        minimumBid: nativeBid(item.minimumPriceToBid),
    };
}

// What buying it costs right now: the current bid for an auction, the
// price otherwise, and the quoted shipping.
function priceDetails(item: EbayItem) {
    const isAuction = item.buyingOptions?.includes("AUCTION") ?? false;
    const buyingOption: BuyingOption = isAuction ? "AUCTION" : "FIXED_PRICE";

    return {
        price: toAmount(isAuction ? (item.currentBidPrice ?? item.price) : item.price),
        shipping: quotedShipping(item),
        buyingOption,
        bestOffer: item.buyingOptions?.includes("BEST_OFFER") ?? false,
        bids: item.bidCount ?? 0,
        // Fixed-price listings usually have no end date.
        endTime: item.itemEndDate ?? null,
    };
}

// Only retain short condition statements. Seller HTML also contains policies,
// shipping instructions, templates and sometimes an entire grading guide.
function sellerDescriptionNotes(item: EbayItem): string[] {
    const notes = new Set<string>();
    for (const [source, conditionField] of [[item.conditionDescription, true], [item.description, false]] as const) {
        if (!source) continue;
        const plain = source.slice(0, 200_000).replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
            .replace(/<\/?(?:br|p|div|li)\b[^>]*>/gi, "\n").replace(/<[^>]*>/g, " ")
            .replace(/&(?:nbsp|amp|quot|apos|#39|#160);/gi, " ");
        const includesGuide = /\bflaws may include\b/i.test(plain);
        for (const part of plain.split(/[.!?;\n]+/)) {
            const note = part.replace(/\s+/g, " ").trim();
            if (!note || note.length > 600 || /\b(?:refund|returns?|policy|during (?:shipping|transit)|in transit|shipping damage|prevent damage|protect(?:ed|ion)? (?:against|from))\b/i.test(note)) continue;
            const hasCardSubject = /\b(?:card|copy)\b/i.test(note);
            if (!conditionField && (!/\b(?:creas\w*|dent(?:ed|s)?|scratch\w*|whiten\w*|(?:corner|edge|surface) wear|chipping|scuff\w*|tear|torn|damag\w*)\b/i.test(note) ||
                /\b(?:may|might|could|possible|possibly|if|guidelines?|some cards|all cards|cards (?:can|have))\b/i.test(note) ||
                !hasCardSubject && (includesGuide || /\b(?:sleeve|holder|case|toploader|packaging)\b/i.test(note)))) continue;
            notes.add(`Seller description: ${note}`);
            if (notes.size === 8) return [...notes];
        }
    }
    return [...notes];
}

function structuredCondition(item: EbayItem) {
    const fields: Record<string, string> = {};
    const conditionNotes: string[] = [];
    for (const descriptor of item.conditionDescriptors ?? []) {
        const content = descriptor.values?.[0]?.content;
        if (typeof content === "string" && content.trim()) fields[descriptor.name] = content;
        for (const value of descriptor.values ?? []) {
            const notes = (value.additionalInfo ?? []).filter(note => typeof note === "string" && note.trim());
            if (descriptor.name === "Card Condition") conditionNotes.push(...cardSpecificNotes(value.content, notes));
            else conditionNotes.push(...notes);
        }
    }
    conditionNotes.push(...sellerDescriptionNotes(item));
    return { fields, cardCondition: fields["Card Condition"] ?? null, conditionNotes };
}

export function getListingDetails(...args: Parameters<typeof getListingDetailsAtDestination>): Promise<ListingDetails> {
    return withShippingDestination(() => getListingDetailsAtDestination(...args));
}

async function getListingDetailsAtDestination(
    itemId: string,
    { maxAgeHours = DETAILS_MAX_AGE_HOURS, keepReserve = false, expectedPhotos, expectedTitle, allowEndedCache = false, signal }: {
        maxAgeHours?: number; keepReserve?: boolean; expectedPhotos?: readonly string[]; expectedTitle?: string; allowEndedCache?: boolean; signal?: AbortSignal;
    } = {}
): Promise<ListingDetails> {
    signal?.throwIfAborted();
    const key = listingCacheKey(itemId);

    if (maxAgeHours > 0) {
        const saved = await readCache<ListingDetails>(key, maxAgeHours);
        // Older details discarded seller descriptions and stored the category
        // examples as disclosures. Verify active items before making a decision.
        if (saved && (allowEndedCache || !hasSavedConditionExamples(saved)) && (allowEndedCache || saved.availability !== "UNAVAILABLE" || await readCache(key, 1 / 60)) && (expectedTitle === undefined || expectedTitle.trim() === saved.title.trim()) &&
            (expectedPhotos === undefined || (saved.searchPhotoKey !== undefined
                ? saved.searchPhotoKey === photoEvidenceKey(expectedPhotos)
                : searchPhotosFitDetails(expectedPhotos, saved.images)))) {
            signal?.throwIfAborted();
            if (expectedPhotos !== undefined && saved.searchPhotoKey === undefined) {
                saved.searchPhotoKey = photoEvidenceKey(expectedPhotos);
                await writeCache(key, saved);
            }
            signal?.throwIfAborted();
            return cachedShippingDestination(hasSavedConditionExamples(saved) ? { ...saved, conditionNotes: cardSpecificNotes(saved.cardCondition, saved.conditionNotes) } : saved);
        }
    }

    signal?.throwIfAborted();
    const evidence = expectedPhotos === undefined ? "" : photoEvidenceKey(expectedPhotos);
    return shareDetails(JSON.stringify([key, expectedTitle, evidence, keepReserve]), async workSignal => {
        const usage = keepReserve ? await ebayUsage() : null;
        workSignal.throwIfAborted();
        if (usage?.braking) throw new EbayBudgetError("Saving the rest of today's eBay allowance.", "QUOTA");
        let details: ListingDetails;
        try { details = await fetchListingDetails(itemId, keepReserve, workSignal); }
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
    }, signal);
}

async function fetchListingDetails(itemId: string, keepReserve: boolean, signal: AbortSignal): Promise<ListingDetails> {
    const item = await ebayGet<EbayItem>(`/buy/browse/v1/item/${encodeURIComponent(itemId)}`, { keepReserve, signal });
    const { fields, cardCondition, conditionNotes } = structuredCondition(item);

    return {
        retrievedAt: new Date().toISOString(),
        shippingDestination: configuredShippingZip(),
        itemGroupType: item.itemGroupType,
        availability: item.itemEndDate && Date.parse(item.itemEndDate) <= Date.now() || item.estimatedAvailabilities?.some((entry) => entry.estimatedAvailabilityStatus === "OUT_OF_STOCK")
            ? "UNAVAILABLE" : item.estimatedAvailabilities?.some((entry) => ["IN_STOCK", "LIMITED_STOCK"].includes(entry.estimatedAvailabilityStatus ?? "")) ? "ACTIVE" : "UNKNOWN",
        id: item.itemId,
        title: item.title,
        url: item.itemWebUrl,
        images: photosOf(item),
        ...priceDetails(item),
        ...(item.buyingOptions?.includes("AUCTION") ? { auctionBids: auctionBidTerms(item) } : {}),
        ...listingDates(item),
        seller: toSeller(item.seller),
        condition: item.condition ?? null,
        cardCondition,
        conditionNotes,
        aspects: {
            ...Object.fromEntries((item.localizedAspects ?? []).map((aspect) => [aspect.name, aspect.value])),
            ...fields,
        },
    };
}
