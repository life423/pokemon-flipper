import { cardLanguageStatus } from "../../shared/card-language.ts";
import { normalizeCardNumber, sameCardNumber } from "../../shared/card-number.ts";
import { finishClaim } from "../../shared/finish.ts";
import { gradeQualifier, hasSpecialSlabTitle } from "../../shared/grade-qualifier.ts";
import { jungleNoSymbolReason } from "../../shared/jungle-no-symbol.ts";
import { parseListingLink } from "../../shared/listing-link.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { maxBid } from "../../shared/money/underwriting.ts";
import { slabLabelConfidence } from "../../shared/photo-evidence.ts";
import { hasBaseSetFourthPrint } from "../../shared/reprint-release.ts";
import { SEARCH_SOURCE_PAGE_LIMIT } from "../../shared/research-policy.ts";
import { searchAttributes } from "../../shared/search-criteria.ts";
import type { SearchCompetition } from "../../shared/search-diagnostic.ts";
import type { Evaluation, ScreeningSoldReference, Targets } from "../../shared/types.ts";
import { evaluationContextKey, loadPrivateEvaluation } from "../analysis/private-evaluation.ts";
import { EbayError } from "../ebay/api.ts";
import { listingExclusion } from "../ebay/filters.ts";
import { getListingDetails, searchListings, type ListingDetails } from "../ebay/listings.ts";
import { lookAlikeProblem, mapVariantPrintings, printingClaimFromAspects, printingClaimFromText, sameSetFamily, titleContradiction } from "../identity/card-identity.ts";
import { sameCatalogName } from "../identity/catalog-name.ts";
import { resolveScreeningName } from "../identity/screening-name.ts";
import { readSoldTitleClaims } from "../pricing/sold-comps.ts";

const DETAIL_CHECK_LIMIT = 3;
const DETAIL_FRESH_MS = 120_000;
const ALT_ART = /\b(?:alternate|alt)(?:[\s-]+full)?[\s-]+art\b/i;
const SLAB_QUALIFIER = /\b(?:PSA|CGC|BGS|SGC|TAG)\s*\d+(?:\.5)?[\s–—-]+(?:OC|MK|MC|ST|PD|OF)\b/i;
const priceQuoted = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const sameRelease = (set: unknown, reference: ScreeningSoldReference) => sameSetFamily(set, reference.set) && sameSetFamily(reference.set, set);

function sameNumber(value: string | null | undefined, reference: ScreeningSoldReference) {
    const parts = value?.split("/");
    return sameCardNumber(value, reference.cardNumber) &&
        (!parts || parts.length === 1 || parts.length === 2 && normalizeCardNumber(value)?.total != null);
}

function titleMatches(title: string, reference: ScreeningSoldReference) {
    const finish = finishClaim(title);
    const printing = printingClaimFromText(title);
    if (hasSpecialSlabTitle(title) || SLAB_QUALIFIER.test(title) || hasBaseSetFourthPrint(reference.set, title) ||
        jungleNoSymbolReason({ listing: { title }, identity: { set: reference.set } }) ||
        lookAlikeProblem(title, reference.set) || titleContradiction(title, reference.set, reference.cardNumber) ||
        cardLanguageStatus(title) === "OTHER" ||
        finish !== "NOT_STATED" && finish !== reference.finish ||
        printing !== "NOT_STATED" && printing !== reference.printing) return false;

    // "Alt Alternate Art" is a duplicated seller descriptor, not a name.
    const cleanedTitle = title.replace(/\balt\s+(?=alternate(?:\s+full)?\s+art\b)/gi, "");
    const reading = readSoldTitleClaims(cleanedTitle, [reference.set]);
    const name = resolveScreeningName({ title: cleanedTitle, claims: [reading.cardName], candidate: reference.name, set: reference.set });
    return !(reading.kind || reading.cardName && !sameCatalogName(name, reference.name) ||
        reading.set && !sameRelease(reading.set, reference) ||
        reading.cardNumber && !sameNumber(reading.cardNumber, reference) ||
        reading.grader && reading.grader !== reference.grader ||
        reading.grade && Number(reading.grade) !== Number(reference.grade));
}

function exactListingIdentity({ title, aspects }: ListingDetails, reference: ScreeningSoldReference) {
    const { grader, grade } = searchAttributes("", aspects);
    const aspectGrade = aspects.Grade?.replace(/^\s*\d+(?:\.5)?\s*[-–—:]*\s*/, "").replace(/^\((.*)\)$/, "$1");
    if (!sameCatalogName(aspects["Card Name"], reference.name) || !sameRelease(aspects.Set, reference) ||
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
    return Boolean(slabLabelConfidence(evaluation) && identity && slab &&
        sameCatalogName(identity.name, reference.name) && sameRelease(identity.set, reference) &&
        sameNumber(identity.cardNumber, reference) && cardLanguageStatus("", [identity.language]) === "ENGLISH" &&
        finishClaim(identity.finish) === reference.finish && identity.printing === reference.printing &&
        slab.grader === reference.grader && Number(slab.grade) === Number(reference.grade) &&
        ![slab.gradeQualifier, photoCheck?.slab?.gradeQualifier].some(value => gradeQualifier(value, slab.grader, slab.grade)) &&
        ![slab.labelText, photoCheck?.slab?.labelText].some(value => hasSpecialSlabTitle(value ?? "")) &&
        !hasBaseSetFourthPrint(reference.set, slab.labelText, photoCheck?.slab?.labelText) &&
        !jungleNoSymbolReason(evaluation));
}

// A separate competition check, not a source of sold evidence or a deal
// candidate. Use the existing reserve, request accounting, and cache.
export async function findBinCompetition(
    query: string,
    reference: ScreeningSoldReference,
    expectedNet: number,
    targets: Targets | undefined,
    userMax: number | undefined,
    signal?: AbortSignal,
    { search = searchListings, details = getListingDetails, loadEvaluation = loadPrivateEvaluation, now = Date.now } = {},
): Promise<SearchCompetition | undefined> {
    signal?.throwIfAborted();
    const source = await search(query, {
        maxResults: SEARCH_SOURCE_PAGE_LIMIT, sort: "price", keepReserve: true, signal,
        filters: { typeFilter: "FIXED_PRICE", kindFilter: "graded" },
    });
    signal?.throwIfAborted();

    const candidates = source.listings.flatMap(listing => {
        const link = parseListingLink(listing.id);
        const end = listing.endTime === null ? Infinity : Date.parse(listing.endTime);
        return link && listing.buyingOption === "FIXED_PRICE" && listing.availability !== "UNAVAILABLE" && end > now() &&
            priceQuoted(listing.currentPrice) && listing.currentPrice > 0 && titleMatches(listing.title, reference) &&
            !listingExclusion({ title: listing.title, itemId: link.itemId })
            ? [{ link, estimatedDelivered: listing.currentPrice + (priceQuoted(listing.shipping) ? listing.shipping : 0) }] : [];
    }).sort((a, b) => a.estimatedDelivered - b.estimatedDelivered);

    const config = { ...MONEY_CONFIG, targets: targets ?? MONEY_CONFIG.targets };
    let best: SearchCompetition | undefined;
    const checked = new Set<string>();
    for (const { link } of candidates) {
        signal?.throwIfAborted();
        if (checked.has(link.itemId)) continue;
        if (checked.size >= DETAIL_CHECK_LIMIT) break;
        checked.add(link.itemId);

        let listing: ListingDetails;
        try {
            listing = await details(link.itemId, { maxAgeHours: DETAIL_FRESH_MS / 3_600_000, keepReserve: true, signal });
        } catch (error) {
            if (error instanceof EbayError && (error.status === 404 || error.status === 410)) continue;
            throw error;
        }
        signal?.throwIfAborted();
        const asOf = now();
        const retrieved = Date.parse(listing.retrievedAt ?? "");
        if (listing.id !== link.itemId || listing.buyingOption !== "FIXED_PRICE" || listing.availability !== "ACTIVE" ||
            !(retrieved <= asOf && asOf - retrieved <= DETAIL_FRESH_MS) ||
            listing.endTime !== null && !(Date.parse(listing.endTime) > asOf) ||
            !priceQuoted(listing.price) || listing.price <= 0 || !priceQuoted(listing.shipping) ||
            best && listing.price + listing.shipping >= best.price + best.shipping ||
            listingExclusion({ title: listing.title, itemId: listing.id, itemGroupType: listing.itemGroupType }) ||
            !titleMatches(listing.title, reference)) continue;

        const saved = await loadEvaluation(listing.id);
        signal?.throwIfAborted();
        const photoEvidence = saved?.contextKey === evaluationContextKey(listing);
        if (photoEvidence ? !exactPhotoIdentity(saved.evaluation, reference) : !exactListingIdentity(listing, reference)) continue;
        best = {
            title: listing.title, url: link.url, price: listing.price, shipping: listing.shipping,
            ceiling: Math.min(userMax ?? Infinity, maxBid({ expectedNet, fixedCosts: 0, shipping: listing.shipping }, config)),
            identity: photoEvidence ? "PHOTO" : "LISTING",
        };
    }
    return best;
}
