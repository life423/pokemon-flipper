import { withinOpportunityWindow } from "../../shared/auction-opportunity.ts";
import { buyerReviewBlock } from "../../shared/wait-skip-review.ts";
import { freshListingTime } from "../../shared/grading-watch.ts";
import { normalizeCardNumber, sameCardNumber } from "../../shared/card-number.ts";
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
import { EbayBudgetError } from "../ebay/daily-budget.ts";
import { searchListings } from "../ebay/listings.ts";
import { canonicalCatalogName, sameCatalogName } from "../identity/catalog-name.ts";
import { lookAlikeProblem, printingClaimFromText, titleContradiction } from "../identity/card-identity.ts";
import { resolveScreeningName, screeningNameKey } from "../identity/screening-name.ts";
import { setKey } from "../../shared/sets.ts";
import { cachedSetNames } from "../search/set-catalog.ts";
import { isSearchDiagnosticId } from "./search-diagnostic-store.ts";

function collectorNumber(value: string | null | undefined) {
    return (value ?? "").replace(/\s+/g, "").replace(/^#/, "");
}

function browseTerms(intent: SearchIntent) {
    const printed = collectorNumber(intent.cardNumber).split("/")[0];
    const numerator = printed?.replace(/^0+(?=\d+$)/, "");
    const catalogSet = intent.sets[0]?.replace(/^[a-z0-9]+:\s*/i, "").trim();
    const set = /^GG\d+$/i.test(numerator ?? "") && /^crown zenith[:\s-]+galarian gallery$/i.test(catalogSet ?? "")
        ? "Crown Zenith" : catalogSet;
    return { set, numerator };
}

export function marketBrowseQuery(intent: SearchIntent) {
    const { set, numerator } = browseTerms(intent);
    const edition = intent.printing === "FIRST_EDITION" ? "1st Edition" : intent.printing === "SHADOWLESS" ? "Shadowless" : null;
    // Put the number before the set to keep Base Set 2/102 distinct from Base Set 2.
    return [intent.cardName, numerator, set, edition,
        ...(intent.graded ? [intent.grader, intent.minGrade] : [])].filter(Boolean).join(" ");
}

function concreteMarket({ cardName, cardNumber, sets, printing, finish, graded, grader, minGrade, maxGrade }: SearchIntent) {
    return !!cardName?.trim() && !!canonicalCatalogName(cardName) && !!cardNumber && normalizeCardNumber(cardNumber)?.number != null &&
        sets.length === 1 && !!sets[0]?.trim() && isPrinting(printing) && !!finish && typeof graded === "boolean" &&
        (!graded || !!grader && minGrade != null && minGrade === maxGrade && minGrade >= 1 && minGrade <= 10);
}

type MarketQueryStrategy = "full_name" | "collector_number" | "set_number";
export interface MarketQueryObservation {
    strategy: MarketQueryStrategy;
    query: string;
    status: "complete" | "quota";
    total: number | null;
    /** IDs returned by the Browse adapter after its free junk/language gate. */
    returnedIds: string[];
    /** Distinct IDs eligible on this page, including overlap with another query. */
    eligibleIds: string[];
    /** Eligible IDs whose title needed a collector-number clue to reach photo review. */
    numberOnlyIds: string[];
    /** Eligible copies first admitted by this query, excluding earlier hunt inventory. */
    newEligibleIds: string[];
    nextOffset?: number;
    sourceLimitReached?: boolean;
}

interface ListingDiscoveryOptions {
    search?: typeof searchListings;
    knownSets?: typeof cachedSetNames;
    now?: () => number;
    relatedIntents?: SearchIntent[];
    newlyListedRaw?: boolean;
    collectorNumberDiscovery?: "fallback" | "compare";
    knownListingIds?: ReadonlySet<string>;
    isUsable?: (listing: ListingSummary) => boolean;
    onQuery?: (observation: MarketQueryObservation) => void;
    /** A host-owned cursor per alias. null marks an exhausted query. */
    queryOffsets?: Map<MarketQueryStrategy, number | null>;
}

const collectorPart = "[a-z]{0,5}\\d{1,4}[a-z]?";
const collectorId = new RegExp(`^${collectorPart}(?:/${collectorPart})?$`, "i");
const fraction = new RegExp(`^${collectorPart}/${collectorPart}$`, "i");
const printedFractions = new RegExp(`\\b${collectorPart}\\s*/\\s*${collectorPart}\\b`, "gi");
const shippedInHolder = /\b(?:ships?|shipped)\s+(?:in|with)\s+(?:(?:a|an|protective|penny|card|magnetic|hard|soft)\s+)*(?:sleeve|top[ -]?loader|holder|case)\s*[.!]?\s*$/i;

// An omitted name can justify looking at photos. Keep other printed species,
// owners and forms in the residue so a reused number cannot identify the card.
function hasNumberLead(title: string, check: SearchIntent) {
    const expected = check.cardNumber!;
    const titleNumbers = [...title.matchAll(printedFractions)];
    if (titleNumbers.some(match => !sameCardNumber(match[0], expected) || !sameCardNumber(match[0], titleNumbers[0][0]))) return false;
    const { set, numerator } = browseTerms(check);
    const release = setKey(set!);
    if (!release) return false;
    const releasePattern = new RegExp(`\\b${release.split(" ").join("[\\s:–—-]+")}\\b`, "ig");
    let residue = title;
    // An unqualified catalog numerator cannot vouch for a seller's fraction
    // from a different set. The named release must also appear on that lead.
    if ((!titleNumbers.length || !fraction.test(collectorNumber(expected))) && residue.search(releasePattern) < 0) return false;
    if (titleNumbers.length) {
        residue = residue.replace(printedFractions, " ").replace(releasePattern, " ");
    } else {
        // Accept a written release and its standalone collector numerator. Check
        // currency, HP, decimal and fraction boundaries before erasing punctuation.
        const parts = /^([a-z]{0,5})(\d{1,4})([a-z]?)$/i.exec(numerator);
        if (!parts) return false;
        const token = `${parts[1]}0*${Number(parts[2])}${parts[3]}`;
        const collector = new RegExp(`(?<![\\w$£€¥./])(?:#|\\bcard\\s+(?:no\\.?|number)\\s*)?${token}(?![\\w./]|\\s*(?:hp|usd)\\b)`, "ig");
        residue = residue.replace(releasePattern, " ").replace(/([$£€¥])\s+/g, "$1");
        if (!collector.test(residue)) return false;
        residue = residue.replace(collector, " ");
    }
    const words = canonicalCatalogName(residue.replace(shippedInHolder, "")).replace(/\b(?:pok[eé]mon|tcg|trading|cards?|old|shiny|holo(?:graphic|foil)?|reverse|rare|ultra|alternate|alternative|alt|full|art|artwork|english|eng|en|swsh|nm|lp|mint|near|lightly|moderately|heavily|played|unlimited|edition|1st|first|wotc|vintage|raw|ungraded|stage|basic|19\d{2}|20\d{2})\b/g, " ").trim();
    return !words || sameCatalogName(words, check.cardName);
}

async function screenMarketCopy(row: ListingSummary, checks: SearchIntent[], readTitle: (title: string) => ReturnType<typeof readTitleByRules>,
    allowNumber: boolean, requireSetNumber: boolean,
    bounds: ListingFilters, newlyListedRaw: boolean, asOf: number, signal: AbortSignal) {
    const link = parseListingLink(row.url);
    if (!link || link.itemId !== row.id || !link.itemId.endsWith("|0") || screeningBlock(row, bounds, asOf) ||
        newlyListedRaw && freshListingTime(row, asOf) === null || bounds.typeFilter === "AUCTION" && !withinOpportunityWindow(row.endTime, asOf) ||
        !(row.currentPrice && row.currentPrice > 0) || row.endTime && !(Date.parse(row.endTime) > asOf)) return null;

    const { title } = row;
    const reading = readTitle(title);
    if (reading.kind === "NOT_A_CARD" || finishClaim(title) === "CONFLICTING" || printingClaimFromText(title) === "CONFLICTING" ||
        bounds.kindFilter === "graded" && hasSpecialSlabTitle(title)) return null;
    for (const check of checks) {
        const set = check.sets[0], cardName = check.cardName!;
        const observedName = resolveScreeningName({ title, claims: [reading.cardName], candidate: cardName, set });
        const matchesName = observedName ? sameCatalogName(observedName, cardName)
            : (" " + screeningNameKey(title) + " ").includes(" " + screeningNameKey(cardName) + " ");
        if ((!matchesName || requireSetNumber) && !(allowNumber && hasNumberLead(title, check)) || lookAlikeProblem(title, set) ||
            titleContradiction(title, set, check.cardNumber!) || hasBaseSetFourthPrint(set, title) ||
            jungleNoSymbolReason({ listing: { title }, identity: { set } })) continue;
        const screened = await screenListingWithoutAi(row, check, signal, async () => matchesName ? reading : { ...reading, cardName: null });
        if (buyerReviewBlock(screened, asOf) === null) return { listing: screened, numberOnly: !matchesName };
    }
    return null;
}

// The fallback is bounded to two additional pages for the same release and purchase limits.
// Each copy still goes through the normal photo/identity assessment before it can support a buy.
export async function discoverMarketListings(searchId: string, intent: SearchIntent, filters: ListingFilters, signal: AbortSignal,
    { search = searchListings, knownSets = cachedSetNames, now = Date.now, relatedIntents = [], newlyListedRaw = false,
        collectorNumberDiscovery, knownListingIds, isUsable, onQuery, queryOffsets }: ListingDiscoveryOptions = {}): Promise<ListingSummary[]> {
    signal.throwIfAborted();
    if (!isSearchDiagnosticId(searchId) || !concreteMarket(intent)) return [];
    const { graded } = intent;
    const kind = graded ? "graded" : "raw";
    if (filters.kindFilter && filters.kindFilter !== "all" && filters.kindFilter !== kind) return [];
    const auction = filters.typeFilter === "AUCTION";
    if (newlyListedRaw && (auction || graded)) return [];
    const bounds = { ...filters, typeFilter: auction ? "AUCTION" : "FIXED_PRICE", kindFilter: kind } as const;
    const baseline = marketBrowseQuery(intent);
    const number = collectorNumber(intent.cardNumber);
    const hasFraction = fraction.test(number);
    const useNumber = Boolean(collectorNumberDiscovery && !graded && !auction && collectorId.test(number));
    const checks = [intent, ...relatedIntents.filter(other => concreteMarket(other) &&
        graded === other.graded && marketBrowseQuery(other).toLowerCase() === baseline.toLowerCase() &&
        (!useNumber || collectorId.test(collectorNumber(other.cardNumber)) && fraction.test(collectorNumber(other.cardNumber)) === hasFraction &&
            sameCardNumber(other.cardNumber, number)))];
    const queries: { strategy: MarketQueryStrategy; query: string }[] = [{ strategy: "full_name", query: baseline }];
    if (useNumber) {
        const { set, numerator } = browseTerms(intent);
        if (hasFraction) queries.push({ strategy: "collector_number", query: number });
        queries.push({ strategy: "set_number", query: `${set} ${numerator}` });
    }
    const candidates = new Map<string, ListingSummary>();
    // Alias pages overlap. Read each distinct title once, but screen price,
    // shipping, format and timing again from each observation.
    const readings = new Map<string, ReturnType<typeof readTitleByRules>>();
    let releases: string[] | undefined;
    function readTitle(title: string) {
        const saved = readings.get(title);
        if (saved) return saved;
        const reading = readTitleByRules(title, releases);
        readings.set(title, reading);
        return reading;
    }
    const asOf = now();
    for (const { strategy, query } of queries) {
        signal.throwIfAborted();
        if (queryOffsets?.get(strategy) === null) continue;
        const offset = queryOffsets?.get(strategy) ?? 0;
        let page: Awaited<ReturnType<typeof search>>;
        try {
            page = await withAiUsageContext({ searchId }, () => search(query, {
                sort: auction ? "endingSoonest" : newlyListedRaw ? "newlyListed" : "price", filters: bounds, maxResults: SEARCH_SOURCE_PAGE_LIMIT,
                ...(offset && { offset }),
                ...(newlyListedRaw ? {} : { cacheMode: "resume" }), anyCategory: true, keepReserve: true, signal,
            }));
        } catch (error) {
            signal.throwIfAborted();
            if (strategy === "full_name" || !(error instanceof EbayBudgetError && error.reason === "QUOTA")) throw error;
            onQuery?.({ strategy, query, status: "quota", total: null, returnedIds: [], eligibleIds: [], numberOnlyIds: [], newEligibleIds: [] });
            break;
        }
        signal.throwIfAborted();
        if (page.listings.length && !releases) releases = [...new Set([...checks.map(check => check.sets[0]), ...await knownSets()])];
        const returned = new Set<string>(), eligible: string[] = [], numberOnlyIds: string[] = [], added: string[] = [];
        for (const row of page.listings.slice(0, SEARCH_SOURCE_PAGE_LIMIT)) {
            signal.throwIfAborted();
            if (returned.has(row.id)) continue;
            returned.add(row.id);
            const hit = await screenMarketCopy(row, checks, readTitle, useNumber, strategy === "set_number" && !hasFraction,
                bounds, newlyListedRaw, asOf, signal);
            if (!hit || isUsable && !isUsable(hit.listing)) continue;
            eligible.push(row.id);
            if (hit.numberOnly) numberOnlyIds.push(row.id);
            if (knownListingIds?.has(row.id) || candidates.has(row.id)) continue;
            candidates.set(row.id, strategy === "full_name" ? hit.listing : { ...hit.listing,
                found: { how: "NUMBER_ONLY", note: `Found by searching ${query}.` } });
            added.push(row.id);
        }
        queryOffsets?.set(strategy, page.nextOffset ?? null);
        onQuery?.({ strategy, query, status: "complete", total: page.total, returnedIds: [...returned], eligibleIds: eligible, numberOnlyIds, newEligibleIds: added,
            ...(page.nextOffset !== undefined && { nextOffset: page.nextOffset }), ...(page.sourceLimitReached && { sourceLimitReached: true }) });
        if (strategy === "full_name" && collectorNumberDiscovery === "fallback" && candidates.size) break;
    }
    signal.throwIfAborted();
    return [...candidates.values()];
}
