import { isPrinting, normalizeCardNumber, normalizeSetName, printingClaimFromText, sameCardNumber, sameSetFamily, setFamily, titleDecidesPrinting } from "../identity/card-identity.ts";
import { finishClaim } from "../../shared/finish.ts";
import { freshListingTime } from "../../shared/grading-watch.ts";
import { RAW_CONDITIONS } from "../../shared/conditions.ts";
import { StorageUnavailableError } from "../storage/index.ts";
import type { ListingSummary, ScreeningSoldEvidence, ScreeningSoldReference, SearchIntent, Targets } from "../../shared/types.ts";
import type { CardRecord, Comp, FetchComps, FetchRawComps, FetchSoldPage, LookupCards, SoldPage, SoldStream } from "./types.ts";
import { compCondition } from "./raw-comps.ts";
import { compProblem, summarizeComps, readSoldTitleClaims, matchesSoldTarget, uniqueSoldComps, type CompCriteria } from "./sold-comps.ts";
import { createScreeningPriceSource } from "./pkmnprices.ts";
import { PriceResearchBudgetError } from "./research-budget.ts";
import { resolveScreeningName } from "../identity/screening-name.ts";
import { sameNumberedCatalogName } from "../identity/catalog-name.ts";
import { canonicalCatalogName } from "./search-name.ts";
import { jungleNoSymbolReason } from "../../shared/jungle-no-symbol.ts";
import { hasBaseSetFourthPrint } from "../../shared/reprint-release.ts";
import { usableSoldReference } from "../../shared/sold-evidence.ts";
import { SOLD_MARKET_PAGE_LIMIT } from "../../shared/research-policy.ts";
import { hasSpecialSlabTitle, missingTextureReason } from "../../shared/grade-qualifier.ts";
import { analysisPriority, availablePhotoCount } from "../../shared/analysis-priority.ts";
import { applySoldPriceScreen } from "../../shared/money/sold-screen.ts";
import { listingDisclosesCardCrease } from "../../shared/ebay-condition-notes.ts";
import { sellerConditionClues } from "../../shared/raw-condition-claim.ts";

type Source = { lookupCards: LookupCards; fetchComps: FetchComps; fetchRawComps: FetchRawComps; fetchSoldPage?: FetchSoldPage };
type Finish = ScreeningSoldReference["finish"];
interface Market { record: CardRecord; printing: ScreeningSoldReference["printing"]; finish: Finish; labels: string[] }
interface MarketEvidence { references: ScreeningSoldReference[]; issue: "BUDGET" | "UNAVAILABLE" | null }
type SoldScreening = ((listing: ListingSummary, intent: SearchIntent) => Promise<ScreeningSoldEvidence>) & {
    exactSlabReference?: (intent: SearchIntent, query: string) => Promise<ScreeningSoldReference | null>;
};
const FINISHES = ["HOLO", "NON_HOLO", "REVERSE_HOLO"];
const DAY_MS = 86_400_000;
const hasMatchedSales = (references: ScreeningSoldReference[]) => references.some(reference => usableSoldReference(reference, reference.grader !== null));
const ordinarySale = (sale: Comp) => !/\blot\b|\bbundle\b|\bset of\b|\b\d+\s*(?:cards|pcs)\b|\bsigned\b|\bautograph(?:ed)?\b|\baltered\b|\bcustom\b|\bproxy\b|\breplica\b|\bmiscut\b|\bcrimp\b|\bholo\s*bleed\b|\bdouble\s*holo\b/i.test(sale.title);
export function marketSummaries(sales: Comp[], market: Market, grader: string | null, grade: string | null, asOf: number): ScreeningSoldReference[] {
    const { record, printing, finish } = market;
    const exact = { printing, setName: record.setName, cardName: record.name, cardNumber: record.cardNumber, finish };
    const eligible = uniqueSoldComps(sales).filter(sale => sale.currency === "USD" && ordinarySale(sale) && matchesSoldTarget(sale, record, grader, grade));
    const base = { recordId: record.id, name: record.name, set: record.setName!, cardNumber: record.cardNumber, printing, finish };
    if (grader && grade) {
        const criteria: CompCriteria = { ...exact, grader, grade, now: asOf };
        const recent = eligible.filter(sale => compProblem(sale, criteria) === null && asOf - Date.parse(sale.sold_at) <= 90 * DAY_MS);
        const summary = summarizeComps(eligible, { ...criteria, windowDays: recent.length ? 90 : 180 });
        return summary.count ? [{ ...base, grader, grade, condition: null, summary }] : [];
    }
    const raw = eligible.filter(sale => !sale.grader && !sale.grade && !/\b(?:psa|cgc|bgs|sgc|tag)\b/i.test(sale.title));
    const accepted = RAW_CONDITIONS.flatMap<ScreeningSoldReference>(condition => {
        const matching = raw.filter(sale => compCondition(sale.title) === condition).map(sale => ({ ...sale, grader: "RAW", grade: condition }));
        const summary = summarizeComps(matching, { ...exact, grader: "RAW", grade: condition, now: asOf, windowDays: 90 });
        return summary.count ? [{ ...base, grader: null, grade: null, condition, summary }] : [];
    });
    // Unstated condition remains market context, never this copy's condition.
    const unspecified = raw.filter(sale => compCondition(sale.title) === null).map(sale => ({ ...sale, grader: "RAW", grade: "UNSPECIFIED" }));
    const summary = summarizeComps(unspecified, { ...exact, grader: "RAW", grade: "UNSPECIFIED", now: asOf, windowDays: 90 });
    if (summary.count) accepted.push({ ...base, grader: null, grade: null, condition: null, summary });
    return accepted;
}
function incompleteEvidence(evidence: ScreeningSoldEvidence, budget: boolean): ScreeningSoldEvidence {
    const useful = hasMatchedSales(evidence.references);
    return structuredClone({ ...evidence, exactScope: false,
        status: useful ? "AVAILABLE" : budget ? "DEFERRED" : "UNAVAILABLE",
        note: useful
            ? "Matched sold references are retained as partial market context. Remaining source pages or markets could not finish within the bounded request allowance or provider availability; no exclusion can rely on this incomplete scope."
            : budget ? "The bounded price-screening allowance is exhausted. Saved references are retained; missing evidence is deferred."
                : "Recent matched sold-price screening is temporarily unavailable. Missing evidence does not establish a worthless card or a rejected deal.",
    });
}

// Public sold observations only. Listing claims choose research targets but
// never become photo confirmation, condition assessments or deal verdicts.
export function createSoldScreening({ signal, targets, now = Date.now, source = createScreeningPriceSource({ signal }) }:
    { signal?: AbortSignal; targets?: Targets; now?: () => number; source?: Source } = {}): SoldScreening {
    const asOf = now();
    const catalogs = new Map<string, Promise<CardRecord[]>>();
    const pages = new Map<string, Promise<SoldPage>>();
    const references = new Map<string, Promise<MarketEvidence>>();
    let gradingMarket: string | undefined;
    const checked = async <T>(work: () => Promise<T>) => { signal?.throwIfAborted(); const value = await work(); signal?.throwIfAborted(); return value; };
    function memo<T>(cache: Map<string, Promise<T>>, key: string, work: () => Promise<T>) {
        signal?.throwIfAborted();
        let pending = cache.get(key);
        if (!pending) { pending = checked(work); cache.set(key, pending); }
        // Attach immediately even when work synchronously stops its subscriber;
        // a second pre-await abort check would orphan pending's rejection.
        return pending.then(value => { signal?.throwIfAborted(); return value; });
    }
    async function matchingRecords(name: string, set: string, number: string | null) {
        const key = JSON.stringify([canonicalCatalogName(name), setFamily(set).sort(), normalizeCardNumber(number)]);
        const found = await memo(catalogs, key, () => source.lookupCards({ name, set, cardNumber: number ?? "" }));
        const matches = [...new Map(found.filter(record => record.source === "pkmnprices" && sameSetFamily(record.setName, set) &&
            (!number || sameCardNumber(record.cardNumber, number)) &&
            sameNumberedCatalogName(record.name, name, record.setName, record.cardNumber)).map(record => [record.id, record])).values()];
        const identities = new Set(matches.map(record => JSON.stringify([normalizeSetName(record.setName), normalizeCardNumber(record.cardNumber)])));
        return identities.size === matches.length ? matches : [];
    }
    const marketReferences = (market: Market, grader: string | null, grade: string | null, gradingScout = false) => {
        const { record, printing, finish } = market;
        const labels = !gradingScout && titleDecidesPrinting(record.setName)
            ? [...new Set(record.variants.filter(variant => variant.finish === finish).map(variant => variant.name))]
            : [...new Set(market.labels)];
        const key = JSON.stringify([record.id, printing, finish, labels, grader, grade, gradingScout]);
        return memo(references, key, async () => {
            const sales: Comp[] = [];
            let accepted: ScreeningSoldReference[] = [];
            let issue: MarketEvidence["issue"] = null;
            // Read each relevant catalog label's first page, then follow only
            // sparse markets. Counts use fully checked, deduplicated summaries,
            // so unrelated grades, printings and condition buckets cannot stop
            // useful recovery. Four pages total bounds even an endless cursor.
            const pending: { variant: string; cursor?: string; stream?: SoldStream }[] = labels.map(variant => ({ variant }));
            const seen = new Set<string>();
            let pageCount = 0;
            while (pending.length) {
                const { variant, cursor, stream } = pending.shift()!;
                if (cursor && hasMatchedSales(accepted)) continue;
                if (pageCount >= SOLD_MARKET_PAGE_LIMIT) { issue = "BUDGET"; break; }
                // Root cache selection uses this market's eligibility predicate.
                // Provider transport/cache sharing remains keyed by native URL.
                const selectionScope = source.fetchSoldPage ? [printing, finish] : null;
                const pageKey = JSON.stringify([record.id, selectionScope, variant, grader, grade, stream, cursor]);
                if (seen.has(pageKey)) { issue = "UNAVAILABLE"; break; }
                seen.add(pageKey);
                try {
                    const page = await memo(pages, pageKey, async () => source.fetchSoldPage
                        ? source.fetchSoldPage(record.id, { grader, grade, variant, cursor, stream,
                            stopWhen: values => hasMatchedSales(marketSummaries([...values], market, grader, grade, asOf)) })
                        : { sales: await (grader && grade ? source.fetchComps(record.id, { grader, grade, variant }) : source.fetchRawComps(record.id, variant)), nextCursor: null });
                    pageCount++;
                    sales.push(...page.sales);
                    accepted = marketSummaries(sales, market, grader, grade, asOf);
                    if (!gradingScout && page.nextCursor && !hasMatchedSales(accepted)) pending.push({ variant, cursor: page.nextCursor, stream: page.stream });
                } catch (error) {
                    signal?.throwIfAborted();
                    if (error instanceof StorageUnavailableError || error instanceof PriceResearchBudgetError && error.reason !== "LIMIT") throw error;
                    issue = error instanceof PriceResearchBudgetError ? "BUDGET" : "UNAVAILABLE";
                    break;
                }
            }
            return { references: accepted, issue };
        });
    };

    async function gradingReferences(listing: ListingSummary, intent: SearchIntent, market: Market, rawEvidence: ScreeningSoldEvidence) {
        if (listing.isGraded || listing.buyingOption !== "FIXED_PRICE" || !intent.cardName || intent.sets.length !== 1 ||
            !sameNumberedCatalogName(market.record.name, intent.cardName, market.record.setName, market.record.cardNumber) ||
            !sameSetFamily(market.record.setName, intent.sets[0]) ||
            (intent.cardNumber && !sameCardNumber(market.record.cardNumber, intent.cardNumber)) ||
            market.labels.length !== 1 || availablePhotoCount(listing.images) < 2) return [];
        const condition = sellerConditionClues(listing);
        if (condition.severe || condition.claim === "MODERATELY_PLAYED" || listingDisclosesCardCrease(listing)) return [];
        if (rawEvidence.status === "AVAILABLE") {
            // A new copy with no seller condition can also earn a photo check
            // on its grade spread. Neither the omission nor a label assigns a grade.
            const newlyOfferedWithoutCondition = !condition.claim && !condition.ambiguous && freshListingTime(listing, asOf) !== null;
            if (condition.claim !== "MINT" && condition.claim !== "NEAR_MINT" && !newlyOfferedWithoutCondition) return [];
            const raw = applySoldPriceScreen(listing, rawEvidence, { targets });
            if (analysisPriority(raw, targets).band >= 2) return [];
        }

        // One named market per search session. Read at most four root pages,
        // shared across matching listings and with the final pricing cache.
        const key = JSON.stringify([market.record.id, market.printing, market.finish, market.labels[0]]);
        if (gradingMarket && gradingMarket !== key) return [];
        gradingMarket = key;
        const matches: ScreeningSoldReference[] = [];
        for (const grade of ["8", "9"]) {
            for (const grader of ["PSA", "CGC"]) {
                const result = await marketReferences(market, grader, grade, true);
                matches.push(...result.references.filter(reference => reference.summary.windowDays === 90));
                if (result.issue) return matches;
            }
        }
        return matches;
    }

    async function exactSlabReference(intent: SearchIntent, query: string): Promise<ScreeningSoldReference | null> {
        const { cardName, sets, cardNumber, grader, minGrade, maxGrade, finish, printing } = intent;
        const set = sets[0];
        if (!cardName || sets.length !== 1 || !cardNumber || !grader || !/^(?:PSA|CGC|BGS|SGC|TAG)$/.test(grader) ||
            !/^(?:10|[1-9](?:\.5)?)$/.test(String(minGrade)) ||
            minGrade !== maxGrade || intent.graded === false || hasSpecialSlabTitle(query) || hasBaseSetFourthPrint(set, query) ||
            jungleNoSymbolReason({ listing: { title: query }, identity: { set } })) return null;
        try {
            const records = await matchingRecords(cardName, set, cardNumber);
            let market: Market | null = null;
            for (const record of records) {
                if (!record.variants.length) return null;
                for (const variant of record.variants) {
                    if (printing && variant.printing !== printing || finish && variant.finish !== finish) continue;
                    if (!isPrinting(variant.printing) || !FINISHES.includes(variant.finish)) return null;
                    if (market && (market.record.id !== record.id || market.printing !== variant.printing || market.finish !== variant.finish)) return null;
                    market ??= { record, printing: variant.printing, finish: variant.finish as Finish, labels: [] };
                    market.labels.push(variant.name);
                }
            }
            if (!market) return null;
            const { references: [reference], issue } = await marketReferences(market, grader, String(minGrade));
            const newestSale = Date.parse(reference?.summary.newestSale ?? "");
            if (issue || !reference || !usableSoldReference(reference, true) || !(newestSale <= asOf && asOf - newestSale <= 30 * DAY_MS)) return null;
            return { ...reference, soleCatalogVariant: market.record.variants.every(variant =>
                variant.printing === market.printing && variant.finish === market.finish) };
        } catch (error) {
            signal?.throwIfAborted();
            if (error instanceof StorageUnavailableError || error instanceof PriceResearchBudgetError && error.reason !== "LIMIT") throw error;
            return null;
        }
    }

    async function screenListing(listing: ListingSummary, intent: SearchIntent): Promise<ScreeningSoldEvidence> {
        signal?.throwIfAborted();
        const evidence: ScreeningSoldEvidence = { status: "UNAVAILABLE", exactScope: false, references: [], note: "The listing does not establish one exact card market for sold-price screening." };
        const textureError = missingTextureReason(listing.title);
        if (textureError) return { ...evidence, note: textureError };
        const card = listing.screen?.card;
        const reading = readSoldTitleClaims(listing.title, [card?.set, ...intent.sets].filter((set): set is string => Boolean(set)));
        if (reading.kind && reading.kind !== "SINGLE_CARD") return evidence;
        const claimedNames = [card?.name, reading.cardName].filter((value): value is string => Boolean(value?.trim()));
        const claimedSets = [card?.set, reading.set].filter((value): value is string => Boolean(value?.trim()));
        const claimedNumbers = [card?.cardNumber, reading.cardNumber].filter((value): value is string => Boolean(value?.trim()));
        if (claimedSets.some(value => !sameSetFamily(value, claimedSets[0]) && !sameSetFamily(claimedSets[0], value)) ||
            claimedNumbers.some(value => !sameCardNumber(value, claimedNumbers[0]))) return evidence;
        const resolvedName = resolveScreeningName({ title: listing.title, claims: claimedNames, candidate: intent.cardName, set: claimedSets[0] });
        if (claimedNames.length && !resolvedName) return evidence;
        const name = resolvedName ?? intent.cardName;
        const set = claimedSets[0] ?? (intent.sets.length === 1 ? intent.sets[0] : null);
        const number = claimedNumbers[0] ?? intent.cardNumber;
        if (!name || !set) return evidence;
        const unsupportedVariant = jungleNoSymbolReason({ listing: { title: listing.title }, identity: { set } });
        if (unsupportedVariant) return { ...evidence, note: unsupportedVariant };
        const intentOnly = !claimedNames.length || !claimedSets.length || !claimedNumbers.length;
        const titlePrinting = printingClaimFromText(listing.title);
        const screenPrinting = card?.printing && isPrinting(card.printing) ? card.printing : null;
        if (titlePrinting === "CONFLICTING" || screenPrinting && isPrinting(titlePrinting) && screenPrinting !== titlePrinting) return evidence;
        const printing = isPrinting(titlePrinting) ? titlePrinting : screenPrinting;
        const titleFinish = finishClaim(listing.title), listedFinish = listing.listedAttributes?.finish;
        if (titleFinish === "CONFLICTING" || listedFinish && titleFinish !== "NOT_STATED" && listedFinish !== titleFinish) return evidence;
        const finish = titleFinish === "NOT_STATED" ? listedFinish ?? null : titleFinish;
        const titleGrader = reading.grader, listedGrader = listing.listedAttributes?.grader?.toUpperCase();
        const titleGrade = reading.grade, listedGrade = listing.listedAttributes?.grade;
        if (listing.isGraded && (hasSpecialSlabTitle(listing.title) || titleGrader && listedGrader && titleGrader !== listedGrader ||
            titleGrade && listedGrade != null && Number(titleGrade) !== listedGrade)) return evidence;
        const grader = listing.isGraded ? listedGrader ?? titleGrader : null;
        const grade = listing.isGraded ? listedGrade == null ? titleGrade : String(listedGrade) : null;
        if (listing.isGraded && (!grader || !/^(?:PSA|CGC|BGS|SGC|TAG)$/.test(grader) || !grade || !/^(?:10|[1-9](?:\.5)?)$/.test(grade))) return evidence;
        try {
            const matches = await matchingRecords(name, set, number);
            if (!matches.length) return evidence;
            const markets = new Map<string, Market>();
            let unknownVariant = false;
            let queryScoped = false;
            for (const record of matches) for (const variant of record.variants) {
                if (!isPrinting(variant.printing) || !FINISHES.includes(variant.finish)) { unknownVariant = true; continue; }
                if (printing && variant.printing !== printing || finish && variant.finish !== finish) continue;
                // Missing seller claims do not authorize research into variants
                // outside an explicit query. This narrows work, not identity.
                if (!printing && intent.printing && variant.printing !== intent.printing ||
                    !finish && intent.finish && variant.finish !== intent.finish) { queryScoped = true; continue; }
                const key = JSON.stringify([record.id, variant.printing, variant.finish]);
                const market = markets.get(key) ?? { record, printing: variant.printing, finish: variant.finish as Finish, labels: [] };
                market.labels.push(variant.name); markets.set(key, market);
            }
            if (!markets.size) return evidence;
            evidence.exactScope = !intentOnly && !queryScoped && markets.size === 1 && (!unknownVariant || Boolean(printing && finish));
            let incomplete: MarketEvidence["issue"] = null;
            for (const market of markets.values()) {
                const result = await marketReferences(market, grader, grade);
                evidence.references.push(...result.references);
                // Another printing can have a saved response even when this
                // market cannot finish. The source still guards new requests.
                if (result.issue && (incomplete === null || result.issue === "BUDGET")) incomplete = result.issue;
            }
            if (incomplete) return incompleteEvidence(evidence, incomplete === "BUDGET");
            evidence.status = hasMatchedSales(evidence.references) ? "AVAILABLE" : "UNAVAILABLE";
            if (!listing.isGraded && evidence.exactScope) {
                const market = markets.values().next().value!;
                const gradedSales = await gradingReferences(listing, intent, market, evidence);
                if (gradedSales.length) evidence.gradingReferences = gradedSales;
            }
            evidence.note = evidence.status === "AVAILABLE"
                ? listing.isGraded ? "Recent matched sold amounts for the listed exact grader and grade; the photographed label is not yet verified."
                    : "Recent matched raw sold amounts stay in separate seller-condition buckets. Unstated-condition sales provide market context only, never a condition-specific resale value or grade. These references do not assess this listing's condition or grading upside."
                : "No usable recent matched sale supports the requested market. Missing evidence remains visible without inventing a price.";
            if (!evidence.exactScope) evidence.note += queryScoped
                ? " Search criteria narrow this research; photos have not confirmed the requested printing or finish."
                : " Listing claims do not settle one market; possible printings and finishes remain separate.";
            return structuredClone(evidence);
        } catch (error) {
            signal?.throwIfAborted();
            if (error instanceof StorageUnavailableError || error instanceof PriceResearchBudgetError && error.reason !== "LIMIT") throw error;
            return incompleteEvidence(evidence, error instanceof PriceResearchBudgetError);
        }
    }
    return Object.assign(screenListing, { exactSlabReference });
}
