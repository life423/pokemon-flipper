import { cardLanguageStatus } from "../../shared/card-language.ts";
import { normalizeCardNumber, sameCardNumber } from "../../shared/card-number.ts";
import { finishClaim } from "../../shared/finish.ts";
import { gradeQualifier, hasSpecialSlabTitle } from "../../shared/grade-qualifier.ts";
import { jungleNoSymbolReason } from "../../shared/jungle-no-symbol.ts";
import { parseListingLink } from "../../shared/listing-link.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { acquisitionCost, maxBid, netFromSale, pathNumbers } from "../../shared/money/underwriting.ts";
import { slabLabelConfidence } from "../../shared/photo-evidence.ts";
import { photoReviewStatus } from "../../shared/photo-review.ts";
import { soldMarketPrice } from "../../shared/sold-evidence.ts";
import { hasBaseSetFourthPrint } from "../../shared/reprint-release.ts";
import { SEARCH_SOURCE_PAGE_LIMIT } from "../../shared/research-policy.ts";
import { searchAttributes } from "../../shared/search-criteria.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS, type SearchCompetition } from "../../shared/search-diagnostic.ts";
import type { Evaluation, ScreeningSoldReference, Targets } from "../../shared/types.ts";
import { evaluationContextKey, loadPrivateEvaluation } from "../analysis/private-evaluation.ts";
import type { CollectorStrategyEvidence } from "../analysis/collector-strategy-evidence.ts";
import { configuredShippingZip, EbayError } from "../ebay/api.ts";
import { listingExclusion } from "../ebay/filters.ts";
import { getListingDetails, searchListings, type ListingDetails } from "../ebay/listings.ts";
import { lookAlikeProblem, mapVariantPrintings, normalizeSetName, printingClaimFromAspects, printingClaimFromText, sameSetFamily, titleContradiction } from "../identity/card-identity.ts";
import { canonicalCatalogName, sameCatalogName } from "../identity/catalog-name.ts";
import { hasGalleryNumber, resolveScreeningName } from "../identity/screening-name.ts";
import { canMatchLabelText, isSv151Set } from "../identity/matches-label-text.ts";
import { matchesSlabPhoto } from "../identity/slab-photo-text.ts";
import { cachedSetNames } from "../search/set-catalog.ts";
import { readSoldTitleClaims } from "../pricing/sold-comps.ts";

const DETAIL_CHECK_LIMIT = 3;
const ALT_ART = /\b(?:alternate|alt)(?:[\s-]+full)?[\s-]+art\b/i;
const SLAB_QUALIFIER = /\b(?:PSA|CGC|BGS|SGC|TAG)\s*\d+(?:\.5)?[\s–—-]+(?:OC|MK|MC|ST|PD|OF)\b/i;
const priceQuoted = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function sameNumber(value: string | null | undefined, reference: ScreeningSoldReference) {
    const parts = value?.split("/");
    return sameCardNumber(value, reference.cardNumber) &&
        (!parts || parts.length === 1 || parts.length === 2 && normalizeCardNumber(value)?.total != null);
}

function sameRelease(set: unknown, reference: ScreeningSoldReference, number?: string | null) {
    if (sameSetFamily(set, reference.set) && sameSetFamily(reference.set, set)) return true;
    // A matching GG number identifies the Gallery subset on a Crown Zenith listing.
    return normalizeSetName(set) === "crown zenith" && normalizeSetName(reference.set) === "crown zenith galarian gallery" &&
        Boolean(number && hasGalleryNumber(number) && sameNumber(number, reference));
}

// Short release codes on English slab labels can be the seller's only set claim.
const englishLabelReleases: Record<string, string> = {
    OBF: "Obsidian Flames", PAF: "Paldean Fates", MEP: "Mega Evolution Promo", CLC: "Trading Card Game Classic",
};

function paddedCollectorNumber(title: string, cardName: string) {
    // Use only a zero-padded three-digit number directly beside the printed
    // name. Ordinary years, slab grades, prices and certificates are not card numbers.
    const name = canonicalCatalogName(cardName);
    if (!name) return null;
    const clean = title
        .replace(/\b(?:cert(?:ification)?|pop(?:ulation)?|lot|PSA|CGC|BGS|SGC|TAG)\s*(?:(?:gem|mint|mt|nm|number|no)[\s.-]*)*(?:#\s*)?\d+\b|[$€£]\s*\d+/gi, ";")
        .replace(/\b\d{3}\s*(?:HP|copies|dollars)\b/gi, ";");
    const adjacent = clean.match(new RegExp(`\\b${name}\\s+(0\\d{2})\\b|\\b(0\\d{2})\\s+${name}\\b`, "i"));
    return adjacent?.[1] ?? adjacent?.[2] ?? null;
}

function titleMatches(title: string, reference: ScreeningSoldReference, knownSets: readonly string[] = []) {
    const code = title.match(/\b(OBF|PAF|MEP|CLC)[\s-]+(?:EN|English)\b/i)?.[1].toUpperCase();
    if (code && !sameRelease(englishLabelReleases[code], reference)) return false;
    const finish = finishClaim(title);
    const printing = printingClaimFromText(title);
    if (isSv151Set(reference.set) && /\bsv2a\b/i.test(title) || hasSpecialSlabTitle(title) || SLAB_QUALIFIER.test(title) || hasBaseSetFourthPrint(reference.set, title) ||
        jungleNoSymbolReason({ listing: { title }, identity: { set: reference.set } }) ||
        lookAlikeProblem(title, reference.set) || titleContradiction(title, reference.set, reference.cardNumber) ||
        cardLanguageStatus(title) === "OTHER" ||
        finish !== "NOT_STATED" && finish !== reference.finish ||
        printing !== "NOT_STATED" && printing !== reference.printing) return false;

    // "Alt Alternate Art" is a duplicated seller descriptor, not a name.
    const normalizedTitle = isSv151Set(reference.set) ? title.replace(/\b(?:SV\s*[- ]?151|MEW\s+(?:(?:POK[EÉ]MON\s+)?151|EN(?:[- ]+151)?))\b/gi, "151")
        .replace(/\bGEM\s+(?=ILLUSTRATION RARE\b)/gi, "") : title;
    const cleanedTitle = normalizedTitle.replace(/\balt\s+(?=alternate(?:\s+full)?\s+art\b)/gi, "");
    const reading = readSoldTitleClaims(cleanedTitle, [reference.set, ...knownSets]);
    const observedNumber = reading.cardNumber ?? paddedCollectorNumber(cleanedTitle, reference.name);
    const name = resolveScreeningName({ title: cleanedTitle, claims: [reading.cardName], candidate: reference.name, set: reference.set });
    return !(reading.kind || reading.cardName && !sameCatalogName(name, reference.name) ||
        reading.set && !sameRelease(reading.set, reference, reading.cardNumber) ||
        observedNumber && !sameNumber(observedNumber, reference) ||
        reading.grader && reading.grader !== reference.grader ||
        reading.grade && Number(reading.grade) !== Number(reference.grade));
}

function exactListingIdentity({ title, aspects }: ListingDetails, reference: ScreeningSoldReference) {
    const { grader, grade } = searchAttributes("", aspects);
    const aspectGrade = aspects.Grade?.replace(/^\s*\d+(?:\.5)?\s*[-–—:]*\s*/, "").replace(/^\((.*)\)$/, "$1");
    if (!sameCatalogName(aspects["Card Name"], reference.name) || !sameRelease(aspects.Set, reference, aspects["Card Number"]) ||
        !sameNumber(aspects["Card Number"], reference) || cardLanguageStatus(title, [aspects.Language]) !== "ENGLISH" ||
        grader !== reference.grader || grade !== Number(reference.grade) ||
        [aspectGrade, aspects["Grade Qualifier"], aspects["Grade Designation"]].some(value => gradeQualifier(value, grader, reference.grade)) ||
        hasBaseSetFourthPrint(reference.set, aspects.Set, aspects.Edition, aspects.Features, aspects.Printing) ||
        jungleNoSymbolReason({ listing: { title: [title, aspects.Set, aspects.Edition, aspects.Features, aspects.Printing].join(" ") }, identity: { set: reference.set } })) return false;

    const finish = finishClaim(aspects.Finish);
    const titleFinish = finishClaim(title);
    // Some modern alternate-art listings use "Full Art" as the item
    // specific. Accept this only for an exact numbered alternate-art listing.
    const fullArtSpecific = /^\s*full[ -]+art\s*$/i.test(aspects.Finish ?? "");
    const alternateArt = reference.finish === "HOLO" && ALT_ART.test(title) &&
        (fullArtSpecific || !aspects.Finish?.trim() && ALT_ART.test(reference.name));
    if (finish !== "NOT_STATED" ? finish !== reference.finish : titleFinish !== reference.finish && !alternateArt) return false;

    const printing = [printingClaimFromAspects(aspects), printingClaimFromText(aspects.Set)].filter(value => value !== "NOT_STATED");
    if (printing.length) return printing.every(value => value === reference.printing);
    return printingClaimFromText(title) === reference.printing ||
        reference.printing === "UNLIMITED" && !sameSetFamily(reference.set, "Base Set") &&
        mapVariantPrintings(["Holofoil"], reference.set).Holofoil === reference.printing;
}

function exactPhotoIdentity(evaluation: Evaluation, reference: ScreeningSoldReference) {
    const { identity, slab, photoCheck } = evaluation;
    return Boolean(slabLabelConfidence(evaluation) && !photoReviewStatus(evaluation).needsYourReview && identity && slab &&
        slab.caseCondition !== "CRACKED" && photoCheck?.slab?.caseCondition !== "CRACKED" &&
        sameCatalogName(identity.name, reference.name) && sameRelease(identity.set, reference, identity.cardNumber) &&
        sameNumber(identity.cardNumber, reference) && cardLanguageStatus("", [identity.language]) === "ENGLISH" &&
        finishClaim(identity.finish) === reference.finish && identity.printing === reference.printing &&
        slab.grader === reference.grader && Number(slab.grade) === Number(reference.grade) &&
        ![slab.gradeQualifier, photoCheck?.slab?.gradeQualifier].some(value => gradeQualifier(value, slab.grader, slab.grade)) &&
        ![slab.labelText, photoCheck?.slab?.labelText].some(value => hasSpecialSlabTitle(value ?? "")) &&
        !hasBaseSetFourthPrint(reference.set, slab.labelText, photoCheck?.slab?.labelText) &&
        !jungleNoSymbolReason(evaluation));
}

export interface CollectorListingCandidate {
    id: string;
    title: string;
    price: number;
    shipping: number | null;
    total: number | null;
    minimumTotal: number;
}

interface CompetitionOptions {
    search?: typeof searchListings;
    details?: typeof getListingDetails;
    loadEvaluation?: typeof loadPrivateEvaluation;
    checkLabel?: typeof matchesSlabPhoto;
    now?: () => number;
    minPrice?: number;
    maxPrice?: number;
    includeUngraded?: boolean;
    cacheMode?: "refresh" | "resume";
    knownSets?: readonly string[];
}

async function discoverListings(query: string, reference: ScreeningSoldReference, signal: AbortSignal | undefined,
    { search = searchListings, now = Date.now, minPrice = 0, maxPrice, includeUngraded = false, cacheMode, knownSets }: CompetitionOptions) {
    const source = await search(query, {
        maxResults: SEARCH_SOURCE_PAGE_LIMIT, sort: "price", keepReserve: true, signal, ...(cacheMode && { cacheMode }),
        filters: { typeFilter: "FIXED_PRICE", kindFilter: includeUngraded ? "all" : "graded",
            ...(minPrice > 0 && { minPrice }), ...(maxPrice !== undefined && { maxPrice }) },
    });
    signal?.throwIfAborted();
    const rows = new Map<string, CollectorListingCandidate>();
    for (const listing of source.listings) {
        const link = parseListingLink(listing.id);
        const end = listing.endTime === null ? Infinity : Date.parse(listing.endTime);
        const price = listing.currentPrice;
        if (!link || rows.has(link.itemId) || listing.buyingOption !== "FIXED_PRICE" || listing.availability === "UNAVAILABLE" ||
            !(end > now()) || !priceQuoted(price) || price <= 0 || price < minPrice || maxPrice !== undefined && price > maxPrice ||
            !titleMatches(listing.title, reference, knownSets) || listingExclusion({ title: listing.title, itemId: link.itemId })) continue;
        const shipping = priceQuoted(listing.shipping) ? listing.shipping : null;
        const minimumTotal = acquisitionCost(price, shipping ?? 0, MONEY_CONFIG.buying);
        rows.set(link.itemId, { id: link.itemId, title: listing.title, price, shipping,
            total: shipping === null ? null : minimumTotal, minimumTotal });
    }
    const fetched = source.listings.length + source.skipped;
    return { candidates: [...rows.values()].sort((a, b) => a.minimumTotal - b.minimumTotal),
        fetched, rejected: fetched - rows.size, total: source.total, retained: source.listings.length };
}

export async function discoverCollectorListings(query: string, reference: ScreeningSoldReference, signal?: AbortSignal,
    options: CompetitionOptions = {}) {
    if (!configuredShippingZip()) throw new Error("A shipping ZIP is required for a live collector search.");
    if (options.maxPrice !== undefined && !priceQuoted(options.maxPrice)) throw new Error("Invalid item-price limit.");
    return discoverListings(query, reference, signal, { cacheMode: "refresh", ...options, knownSets: options.knownSets ?? await cachedSetNames() });
}

type Verification = { status: "verified"; reason: string; listing: SearchCompetition }
    | { status: "excluded" | "unresolved"; reason: string; listing: null };
const excluded = (reason: string): Verification => ({ status: "excluded", reason, listing: null });
const unresolved = (reason: string): Verification => ({ status: "unresolved", reason, listing: null });

function savedLabelMatches(listing: ListingDetails, reference: ScreeningSoldReference, saved: CollectorStrategyEvidence) {
    return saved.reference.recordId === reference.recordId && saved.reference.printing === reference.printing &&
        saved.reference.finish === reference.finish && saved.label?.grader === reference.grader && saved.label?.grade === reference.grade &&
        !!saved.label?.cert && saved.label.cert === listing.aspects["Certification Number"] &&
        saved.listing.title === listing.title && saved.listing.image === listing.images[0] &&
        parseListingLink(saved.listing.url)?.itemId === listing.id && canMatchLabelText(listing, reference);
}

async function verifyCandidate(candidate: CollectorListingCandidate, reference: ScreeningSoldReference,
    expectedNet: number, targets: Targets | undefined, signal: AbortSignal | undefined,
    { details = getListingDetails, loadEvaluation = loadPrivateEvaluation, checkLabel = matchesSlabPhoto,
        now = Date.now, minPrice = 0, maxPrice, knownSets }: CompetitionOptions, strategy?: CollectorStrategyEvidence,
    bestDelivered = Infinity): Promise<Verification> {
    const link = parseListingLink(candidate.id);
    if (!link) return excluded("Invalid eBay item ID.");
    let listing: ListingDetails;
    try {
        listing = await details(link.itemId, { maxAgeHours: BEST_BUY_TERMS_MAX_AGE_MS / 3_600_000, keepReserve: true, signal });
    } catch (error) {
        if (error instanceof EbayError && [404, 410].includes(error.status)) return excluded("The listing ended or was removed.");
        throw error;
    }
    signal?.throwIfAborted();
    const asOf = now(), retrieved = Date.parse(listing.retrievedAt ?? "");
    if (listing.id !== link.itemId || listing.buyingOption !== "FIXED_PRICE") return excluded("The item or buying format changed.");
    if (listing.availability === "UNAVAILABLE" || listing.endTime !== null && Date.parse(listing.endTime) <= asOf)
        return excluded("The listing is no longer available.");
    if (listing.availability !== "ACTIVE" || listing.endTime !== null && !Number.isFinite(Date.parse(listing.endTime)) ||
        !(retrieved <= asOf && asOf - retrieved <= BEST_BUY_TERMS_MAX_AGE_MS)) return unresolved("Fresh, active purchase terms were unavailable.");
    if (!priceQuoted(listing.price) || !listing.price) return unresolved("No usable USD asking price.");
    if (listing.price < minPrice || maxPrice !== undefined && listing.price > maxPrice) return excluded("Outside the item-price limit.");
    if (!priceQuoted(listing.shipping)) return unresolved("Shipping to the configured ZIP was not quoted.");
    if (listing.price + listing.shipping >= bestDelivered) return excluded("A checked match has an equal or lower delivered price.");
    if (listingExclusion({ title: listing.title, itemId: listing.id, itemGroupType: listing.itemGroupType }) ||
        !titleMatches(listing.title, reference, knownSets)) return excluded("The listing conflicts with the requested card or slab.");

    const saved = await loadEvaluation(listing.id);
    signal?.throwIfAborted();
    const photoEvidence = saved?.contextKey === evaluationContextKey(listing);
    const resale = soldMarketPrice(reference.summary);
    const config = { ...MONEY_CONFIG, targets: targets ?? MONEY_CONFIG.targets };
    const numbers = pathNumbers({ expectedNet, fixedCosts: 0, shipping: listing.shipping, price: listing.price }, config);
    let identity: SearchCompetition["identity"];
    if (photoEvidence) {
        if (!exactPhotoIdentity(saved.evaluation, reference)) return unresolved("The saved photo assessment does not confirm an intact exact slab.");
        identity = "PHOTO";
    } else if (strategy && savedLabelMatches(listing, reference, strategy)) {
        identity = "LABEL";
    } else if (!strategy && exactListingIdentity(listing, reference)) {
        identity = "LISTING";
    } else {
        if (!strategy && (resale === null || numbers.cost > resale)) return unresolved("An exact slab label would be needed.");
        if (!listing.images.length || !await checkLabel(listing, reference, signal)) return unresolved("The listing photo could not verify the exact English slab and grade.");
        signal?.throwIfAborted();
        identity = "LABEL";
    }
    const concerns = photoEvidence ? [...new Set([
        ...saved.evaluation.slab?.concerns ?? [], ...saved.evaluation.photoCheck?.slab?.concerns ?? [],
    ])] : [];
    return { status: "verified", reason: identity === "LISTING" ? "Matched eBay item specifics and current terms." : "Matched the slab photo and current purchase terms.",
        listing: { title: listing.title, url: link.url, price: listing.price, shipping: listing.shipping,
            ceiling: Math.min(maxPrice ?? Infinity, maxBid({ expectedNet, fixedCosts: 0, shipping: listing.shipping }, config)),
            identity, ...(resale !== null && { pricing: { resale, totalCost: numbers.cost, profit: numbers.profit, roi: numbers.roi, sales: reference.summary.count } }),
            ...(listing.images[0] && { image: listing.images[0] }), seller: listing.seller, checkedAt: listing.retrievedAt,
            ...(concerns.length && { concerns }),
        } };
}

export async function verifyCollectorListing(candidate: CollectorListingCandidate, reference: ScreeningSoldReference,
    savedEvidence: CollectorStrategyEvidence, signal?: AbortSignal, options: CompetitionOptions = {}) {
    if (!configuredShippingZip()) throw new Error("A shipping ZIP is required for a live collector search.");
    const resale = soldMarketPrice(reference.summary);
    if (resale === null) return unresolved("No matching saved sale price.");
    return verifyCandidate(candidate, reference, netFromSale(resale, "graded", MONEY_CONFIG.selling),
        { minProfit: 0, minRoi: 0 }, signal, { ...options, knownSets: options.knownSets ?? await cachedSetNames() }, savedEvidence);
}

// Compare current asking prices within one exact slab market. Sold evidence
// supplies resale math independently of whether any ask is profitable.
export async function findBinCompetition(query: string, reference: ScreeningSoldReference, expectedNet: number,
    targets: Targets | undefined, userMax: number | undefined, signal?: AbortSignal, options: CompetitionOptions = {}): Promise<SearchCompetition | undefined> {
    signal?.throwIfAborted();
    const minPrice = options.minPrice ?? 0;
    if (!priceQuoted(minPrice) || userMax !== undefined && (!priceQuoted(userMax) || minPrice > userMax)) return undefined;
    const scope = { ...options, maxPrice: userMax };
    const source = await discoverListings(query, reference, signal, scope);
    let best: SearchCompetition | undefined, checked = 0;
    for (const candidate of source.candidates) {
        signal?.throwIfAborted();
        const bestDelivered = best ? best.price + best.shipping : Infinity;
        if (checked >= DETAIL_CHECK_LIMIT || candidate.price + (candidate.shipping ?? 0) >= bestDelivered) break;
        checked++;
        const result = await verifyCandidate(candidate, reference, expectedNet, targets, signal, scope, undefined, bestDelivered);
        if (result.listing) best = result.listing;
    }
    return best && { ...best, coverage: { found: source.retained, checked } };
}
