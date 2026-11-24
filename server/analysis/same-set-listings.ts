import { withinOpportunityWindow } from "../../shared/auction-opportunity.ts";
import { autoAnalysisBlockReason } from "../../shared/analysis.ts";
import { normalizeCardNumber } from "../../shared/card-number.ts";
import { finishClaim } from "../../shared/finish.ts";
import { hasSpecialSlabTitle } from "../../shared/grade-qualifier.ts";
import { isPrinting } from "../../shared/identity.ts";
import { jungleNoSymbolReason } from "../../shared/jungle-no-symbol.ts";
import { screeningBlock, type ListingFilters } from "../../shared/listing-filters.ts";
import { parseListingLink } from "../../shared/listing-link.ts";
import { hasBaseSetFourthPrint } from "../../shared/reprint-release.ts";
import { SEARCH_SOURCE_PAGE_LIMIT } from "../../shared/research-policy.ts";
import type { ListingSummary, SearchIntent } from "../../shared/types.ts";
import { readTitleByRules } from "../ai/title-reader.ts";
import { withAiUsageContext } from "../ai/usage-context.ts";
import { screenListingWithoutAi } from "../deals/screen-listing.ts";
import { searchListings } from "../ebay/listings.ts";
import { canonicalCatalogName, sameCatalogName } from "../identity/catalog-name.ts";
import { lookAlikeProblem, printingClaimFromText, titleContradiction } from "../identity/card-identity.ts";
import { resolveScreeningName, screeningNameKey } from "../identity/screening-name.ts";
import { cachedSetNames } from "../search/set-catalog.ts";
import { isSearchDiagnosticId } from "./search-diagnostic-store.ts";

export function marketBrowseQuery(intent: SearchIntent) {
    const edition = intent.printing === "FIRST_EDITION" ? "1st Edition" : intent.printing === "SHADOWLESS" ? "Shadowless" : null;
    const printed = intent.cardNumber?.trim().split("/")[0]?.replace(/^#/, "");
    const numerator = printed?.replace(/^0+(?=\d+$)/, "");
    const catalogSet = intent.sets[0]?.replace(/^[a-z0-9]+:\s*/i, "").trim();
    const set = /^GG\d+$/i.test(numerator ?? "") && /^crown zenith[:\s-]+galarian gallery$/i.test(catalogSet ?? "")
        ? "Crown Zenith" : catalogSet;
    // Put the number before the set to keep Base Set 2/102 distinct from Base Set 2.
    return [intent.cardName, numerator, set, edition,
        ...(intent.graded ? [intent.grader, intent.minGrade] : [])].filter(Boolean).join(" ");
}

function concreteMarket({ cardName, cardNumber, sets, printing, finish, graded, grader, minGrade, maxGrade }: SearchIntent) {
    return !!cardName?.trim() && !!canonicalCatalogName(cardName) && !!cardNumber && normalizeCardNumber(cardNumber)?.number != null &&
        sets.length === 1 && !!sets[0]?.trim() && isPrinting(printing) && !!finish && typeof graded === "boolean" &&
        (!graded || !!grader && minGrade != null && minGrade === maxGrade && minGrade >= 1 && minGrade <= 10);
}

interface ListingDiscoveryOptions {
    search?: typeof searchListings;
    knownSets?: typeof cachedSetNames;
    now?: () => number;
    relatedIntents?: SearchIntent[];
}

// One live page can serve several exits for the same physical card. Keep the exact
// screening criteria for each exit even when eBay uses identical search keywords.
export async function discoverMarketListings(searchId: string, intent: SearchIntent, filters: ListingFilters, signal: AbortSignal,
    { search = searchListings, knownSets = cachedSetNames, now = Date.now, relatedIntents = [] }: ListingDiscoveryOptions = {}): Promise<ListingSummary[]> {
    signal.throwIfAborted();
    if (!isSearchDiagnosticId(searchId) || !concreteMarket(intent)) return [];
    const { graded } = intent;
    const kind = graded ? "graded" : "raw";
    if (filters.kindFilter && filters.kindFilter !== "all" && filters.kindFilter !== kind) return [];
    const auction = filters.typeFilter === "AUCTION";
    const bounds = { ...filters, typeFilter: auction ? "AUCTION" : "FIXED_PRICE", kindFilter: kind } as const;
    const query = marketBrowseQuery(intent);
    const checks = [intent, ...relatedIntents.filter(other => concreteMarket(other) &&
        graded === other.graded && marketBrowseQuery(other).toLowerCase() === query.toLowerCase())];
    const page = await withAiUsageContext({ searchId }, () => search(query, {
        sort: auction ? "endingSoonest" : "price", filters: bounds, maxResults: SEARCH_SOURCE_PAGE_LIMIT, cacheMode: "resume", keepReserve: true, signal,
    }));
    signal.throwIfAborted();
    if (!page.listings.length) return [];
    const releases = [...new Set([...checks.map(check => check.sets[0]), ...await knownSets()])];
    const candidates = new Map<string, ListingSummary>();
    const asOf = now();
    for (const row of page.listings.slice(0, SEARCH_SOURCE_PAGE_LIMIT)) {
        signal.throwIfAborted();
        const link = parseListingLink(row.url);
        if (!link || link.itemId !== row.id || !link.itemId.endsWith("|0") || candidates.has(row.id) ||
            screeningBlock(row, bounds, asOf) || auction && !withinOpportunityWindow(row.endTime, asOf) || !(row.currentPrice && row.currentPrice > 0) ||
            row.endTime && !(Date.parse(row.endTime) > asOf)) continue;
        const { title } = row;
        const reading = readTitleByRules(title, releases);
        if (finishClaim(title) === "CONFLICTING" || printingClaimFromText(title) === "CONFLICTING" ||
            graded && hasSpecialSlabTitle(title)) continue;
        for (const check of checks) {
            const set = check.sets[0], cardName = check.cardName!;
            const observedName = resolveScreeningName({ title, claims: [reading.cardName], candidate: cardName, set });
            const matchesName = observedName ? sameCatalogName(observedName, cardName)
                : (" " + screeningNameKey(title) + " ").includes(" " + screeningNameKey(cardName) + " ");
            if (!matchesName || lookAlikeProblem(title, set) || titleContradiction(title, set, check.cardNumber!) ||
                hasBaseSetFourthPrint(set, title) || jungleNoSymbolReason({ listing: { title }, identity: { set } })) continue;
            const screened = await screenListingWithoutAi(row, check, signal, async () => reading);
            if (autoAnalysisBlockReason(screened, asOf) !== null) continue;
            candidates.set(row.id, screened);
            break;
        }
    }
    return [...candidates.values()];
}
