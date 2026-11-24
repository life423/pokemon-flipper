import { configuredShippingZip, ebayGet, EbayError } from "./api.ts";
import { listingExclusion, normalizeText } from "./filters.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { ebayUsage, EbayBudgetError } from "./usage.ts";
import { createSharedWork } from "../lib/shared-work.ts";
import { getBudgetContext } from "../ai/usage-context.ts";
import { EbaySearchBudgetError } from "./search-budget.ts";
import { photoEvidenceKey, searchPhotosFitDetails } from "../../shared/listing-evidence.ts";
import type { BuyingOption, ListingSummary, Seller } from "../../shared/types.ts";
import type { ListingFilters } from "../../shared/listing-filters.ts";
import { cardLanguageStatus, EnglishOnlyError } from "../../shared/card-language.ts";
import type { SourceRejectionReason } from "../../shared/search-diagnostic.ts";
import { money } from "../../shared/money/cents.ts";
import { cardSpecificNotes, hasSavedConditionExamples } from "../../shared/ebay-condition-notes.ts";

// Toys & Hobbies > Collectible Card Games > CCG Individual Cards
export const CCG_INDIVIDUAL_CARDS = "183454";

// eBay's condition IDs for ungraded and graded trading cards.
const UNGRADED = "4000";
const GRADED = "2750";

// eBay's maximum page size.
const PAGE_SIZE = 200;

// eBay limits requests per day, so answers are saved. A search is saved
// briefly, since its prices move. A listing's details (photos, item
// specifics, seller) are saved for a week. Purchase terms come from
// whichever provider response was observed more recently.
const SEARCH_MAX_AGE_HOURS = 10 / 60;
export const DETAILS_MAX_AGE_HOURS = 24 * 7;

const shareSearches = createSharedWork();
const shareDetails = createSharedWork();

// Quotes are destination-specific. Adding/changing a ZIP must not reuse a
// quote (or a missing quote) fetched for another destination.
export function shippingCacheScope(): string {
    const zip = configuredShippingZip();
    return zip ? `:ship-to:${encodeURIComponent(zip)}` : "";
}
export const listingCacheKey = (itemId: string, shippingScope = shippingCacheScope()) => `ebay:item:${itemId}${shippingScope}`;

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

function toListing(item: EbayItem, termsCheckedAt: string): ListingSummary {
    const { price, ...rest } = priceDetails(item);
    const { cardCondition, conditionNotes } = structuredCondition(item);

    return {
        id: item.itemId,
        title: item.title,
        currentPrice: price,
        termsCheckedAt,
        ...rest,
        ...listingDates(item),
        ...(cardCondition ? { cardCondition } : {}),
        ...(conditionNotes.length ? { conditionNotes } : {}),
        isGraded: item.conditionId === GRADED,
        categoryId: item.categories?.[0]?.categoryId,
        seller: toSeller(item.seller),
        images: photosOf(item),
        url: item.itemWebUrl,
    };
}

interface SearchResult {
    listings: ListingSummary[];
    total: number;
    skipped: number;
    // Earlier cache entries contain only the aggregate skipped count.
    rejections?: { id: string; reason: SourceRejectionReason }[];
    unidentifiable?: number;
}

export async function searchListings(
    search: string,
    {
        maxResults = PAGE_SIZE,
        anyCategory = false,
        cacheMode,
        keepReserve = false,
        signal,
        sort,
        filters,
    }: { maxResults?: number; anyCategory?: boolean; cacheMode?: "refresh" | "resume"; keepReserve?: boolean; signal?: AbortSignal; sort?: "newlyListed" | "price" | "endingSoonest"; filters?: ListingFilters } = {}
): Promise<SearchResult> {
    if (cardLanguageStatus(search) === "OTHER") throw new EnglishOnlyError();
    const scope = anyCategory ? "any" : "cards";
    signal?.throwIfAborted();
    const buyingOption = filters?.typeFilter && filters.typeFilter !== "all" ? filters.typeFilter : undefined;
    const kind = filters?.kindFilter && filters.kindFilter !== "all" ? filters.kindFilter : undefined;
    // Preserve the cache keys for existing format/kind searches without an end-date filter.
    const filterScope = buyingOption || kind ? `:filters:${JSON.stringify([buyingOption ?? null, kind ?? null, null])}` : "";
    // Filter BIN prices before eBay selects the bounded page, or out-of-range
    // inventory can hide every affordable listing. Auction current bids keep
    // their local checks; the BIN minimum must never exclude low opening bids.
    const validPrice = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
    const lower = buyingOption === "FIXED_PRICE" && validPrice(filters?.minPrice) && filters.minPrice > 0 ? filters.minPrice : undefined;
    const upper = buyingOption === "FIXED_PRICE" && validPrice(filters?.maxPrice) ? filters.maxPrice : undefined;
    if (lower !== undefined && upper !== undefined && lower > upper) return { listings: [], total: 0, skipped: 0, rejections: [] };
    const priceRange = upper !== undefined ? `${lower ?? ""}..${upper}` : lower !== undefined ? String(lower) : null;
    const priceScope = priceRange === null ? "" : `:price:USD:${priceRange}`;
    const key = `ebay:search:${maxResults}:${scope}:language:en:${sort ? `${sort}:` : ""}${normalizeText(search).trim()}${shippingCacheScope()}${filterScope}${priceScope}`;
    const load = async (signal: AbortSignal): Promise<SearchResult> => {
        const saved = await readCache<SearchResult>(key, sort && cacheMode !== "resume" ? 1 / 60 : SEARCH_MAX_AGE_HOURS);
        signal.throwIfAborted();

        if (cacheMode !== "refresh" && saved) return { ...saved, listings: saved.listings.map(listing =>
            hasSavedConditionExamples(listing) ? { ...listing, conditionNotes: cardSpecificNotes(listing.cardCondition, listing.conditionNotes!) } : listing) };

        // The few search requests are refused only when the day's allowance is gone.
        const usage = await ebayUsage();

        if (usage && usage.remaining < Math.ceil(maxResults / PAGE_SIZE)) {
            throw new EbayBudgetError("eBay's daily limit is used up. It resets at midnight Pacific.", "QUOTA");
        }

        const listings: ListingSummary[] = [];
        const seen = new Set<string>();
        const rejections = new Map<string, SourceRejectionReason>();
        let unidentifiable = 0;
        let total = 0;
        // Junk the free rules dropped: lots, sealed product, merch, fakes.
        let skipped = 0;

        for (let offset = 0; offset < maxResults; offset += PAGE_SIZE) {
            signal.throwIfAborted();
            if (keepReserve && (await ebayUsage())?.braking) {
                throw new EbayBudgetError("Saving the rest of today's eBay allowance; extra searches paused.", "QUOTA");
            }
            const filter = [`buyingOptions:{${buyingOption ?? "AUCTION|FIXED_PRICE"}}`, `conditionIds:{${kind === "raw" ? UNGRADED : kind === "graded" ? GRADED : `${UNGRADED}|${GRADED}`}}`];
            if (priceRange !== null) filter.push(`price:[${priceRange}]`, "priceCurrency:USD");
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
            signal.throwIfAborted();
            const termsCheckedAt = new Date().toISOString();
            const items = page.itemSummaries ?? [];
            total = page.total ?? total;

            for (const item of items) {
                if (seen.has(item.itemId)) continue;

                if (typeof item.itemId !== "string" || !/^[\w|\-]{1,120}$/.test(item.itemId)) {
                    unidentifiable++;
                    skipped += 1;
                    continue;
                }
                const exclusion = listingExclusion(item);
                const language = exclusion ? null : cardLanguageStatus(item.title,
                    item.localizedAspects?.filter(aspect => aspect.name.toLowerCase() === "language").map(aspect => aspect.value));
                const reason = exclusion ?? (language === "OTHER" ? "OTHER_LANGUAGE" : null);
                if (reason) {
                    skipped += 1;
                    rejections.set(item.itemId, reason);
                    continue;
                }

                seen.add(item.itemId);
                rejections.delete(item.itemId);
                listings.push(toListing(item, termsCheckedAt));
            }

            if (items.length < PAGE_SIZE || offset + PAGE_SIZE >= total) break;
        }

        console.log(`Search ${JSON.stringify(search)}: eBay has ${total}; kept ${listings.length} single cards`);

        const result: SearchResult = { listings, total, skipped,
            rejections: Array.from(rejections, ([id, reason]) => ({ id, reason })),
            ...(unidentifiable ? { unidentifiable } : {}),
        };
        await writeCache(key, result);
        return result;
    };

    const { searchId } = getBudgetContext();
    // A shared one-page response uses the initiating search's allowance.
    // Multi-page work stays with its search ID, and reserve policies stay separate.
    const sharedKey = JSON.stringify([key, keepReserve, cacheMode, maxResults > PAGE_SIZE ? searchId : null]);
    for (;;) {
        const outcome = await shareSearches(sharedKey, async workSignal => {
            try { return { result: await load(workSignal) }; }
            catch (error) {
                if (!(error instanceof EbaySearchBudgetError)) throw error;
                return { error, searchId };
            }
        }, signal);
        if (outcome.result) return structuredClone(outcome.result);
        if (outcome.searchId === searchId) throw outcome.error;
        // A different search can still pay for this page if the initiating
        // search could not reserve it. All waiting searches can share that work.
    }
}

// A listing's details, saved for a week. maxAgeHours: 0 always asks eBay.
// keepReserve: refuse to ask eBay once the day's allowance is in reserve
// (the free check's bulk lookups); a deliberate analysis still asks.
export async function getListingDetails(
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
            return hasSavedConditionExamples(saved) ? { ...saved, conditionNotes: cardSpecificNotes(saved.cardCondition, saved.conditionNotes) } : saved;
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
