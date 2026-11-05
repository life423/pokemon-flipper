import { isPrinting, normalizeCardNumber, normalizeSetName, printingClaimFromText, sameCardNumber, sameSetFamily, setFamily, titleDecidesPrinting } from "../identity/card-identity.ts";
import { finishClaim } from "../../shared/finish.ts";
import { RAW_CONDITIONS } from "../../shared/conditions.ts";
import { StorageUnavailableError } from "../storage/index.ts";
import type { ListingSummary, ScreeningSoldEvidence, ScreeningSoldReference, SearchIntent } from "../../shared/types.ts";
import type { CardRecord, Comp, FetchComps, FetchRawComps, FetchSoldPage, LookupCards, SoldPage, SoldStream } from "./types.ts";
import { compCondition } from "./raw-comps.ts";
import { compProblem, summarizeComps, readSoldTitleClaims, matchesSoldTarget, uniqueSoldComps, type CompCriteria } from "./sold-comps.ts";
import { createScreeningPriceSource, ScreeningPriceBudgetError } from "./pkmnprices.ts";
import { PriceResearchBudgetError } from "./research-budget.ts";
import { resolveScreeningName } from "../identity/screening-name.ts";
import { canonicalCatalogName, sameCatalogName } from "./search-name.ts";
import { jungleNoSymbolReason } from "../../shared/jungle-no-symbol.ts";
import { usableSoldReference } from "../../shared/sold-evidence.ts";
import { SOLD_MARKET_PAGE_LIMIT } from "../../shared/research-policy.ts";

type Source = { lookupCards: LookupCards; fetchComps: FetchComps; fetchRawComps: FetchRawComps; fetchSoldPage?: FetchSoldPage };
type Finish = ScreeningSoldReference["finish"];
interface Market { record: CardRecord; printing: ScreeningSoldReference["printing"]; finish: Finish; labels: string[] }
interface MarketEvidence { references: ScreeningSoldReference[]; complete: boolean; issue: "BUDGET" | "UNAVAILABLE" | null }
const FINISHES = ["HOLO", "NON_HOLO", "REVERSE_HOLO"];
const DAY_MS = 86_400_000;
const hasMatchedSales = (references: ScreeningSoldReference[]) => references.some(reference => usableSoldReference(reference, reference.grader !== null));
const ordinarySale = (sale: Comp) => !/\blot\b|\bbundle\b|\bset of\b|\b\d+\s*(?:cards|pcs)\b|\bsigned\b|\bautograph(?:ed)?\b|\baltered\b|\bcustom\b|\bproxy\b|\breplica\b|\bmiscut\b|\bcrimp\b|\bholo\s*bleed\b|\bdouble\s*holo\b/i.test(sale.title);
const specialSlab = (title: string) => /\((?:oc|mk|mc|st|pd|of)\)|\b(?:pristine|black label|perfect|altered|miscut|qualified|qualifier|authentic(?:ated)?)\b/i.test(title);
function marketSummaries(sales: Comp[], market: Market, grader: string | null, grade: string | null, asOf: number): ScreeningSoldReference[] {
    const { record, printing, finish } = market;
    const eligible = uniqueSoldComps(sales).filter(sale => sale.currency === "USD" && ordinarySale(sale) && matchesSoldTarget(sale, record, grader, grade));
    const base = { recordId: record.id, name: record.name, set: record.setName!, cardNumber: record.cardNumber, printing, finish };
    if (grader && grade) {
        const ordinary = eligible.filter(sale => !specialSlab(sale.title));
        const criteria: CompCriteria = { printing, setName: record.setName, finish, grader, grade, now: asOf };
        const recent = ordinary.filter(sale => compProblem(sale, criteria) === null && asOf - Date.parse(sale.sold_at) <= 90 * DAY_MS);
        const summary = summarizeComps(ordinary, { ...criteria, windowDays: recent.length ? 90 : 180 });
        return summary.count ? [{ ...base, grader, grade, condition: null, summary }] : [];
    }
    const raw = eligible.filter(sale => !sale.grader && !sale.grade && !/\b(?:psa|cgc|bgs|sgc|tag)\b/i.test(sale.title));
    const accepted = RAW_CONDITIONS.flatMap<ScreeningSoldReference>(condition => {
        const matching = raw.filter(sale => compCondition(sale.title) === condition).map(sale => ({ ...sale, grader: "RAW", grade: condition }));
        const summary = summarizeComps(matching, { printing, setName: record.setName, finish, grader: "RAW", grade: condition, now: asOf, windowDays: 90 });
        return summary.count ? [{ ...base, grader: null, grade: null, condition, summary }] : [];
    });
    // Unstated condition remains market context, never this copy's condition.
    const unspecified = raw.filter(sale => compCondition(sale.title) === null).map(sale => ({ ...sale, grader: "RAW", grade: "UNSPECIFIED" }));
    const summary = summarizeComps(unspecified, { printing, setName: record.setName, finish, grader: "RAW", grade: "UNSPECIFIED", now: asOf, windowDays: 90 });
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
export function createSoldScreening({ signal, now = Date.now, source = createScreeningPriceSource({ signal }) }:
    { signal?: AbortSignal; now?: () => number; source?: Source } = {}) {
    const asOf = now();
    const catalogs = new Map<string, Promise<CardRecord[]>>();
    const pages = new Map<string, Promise<SoldPage>>();
    const references = new Map<string, Promise<MarketEvidence>>();
    const checked = async <T>(work: () => Promise<T>) => { signal?.throwIfAborted(); const value = await work(); signal?.throwIfAborted(); return value; };
    function memo<T>(cache: Map<string, Promise<T>>, key: string, work: () => Promise<T>) {
        signal?.throwIfAborted();
        let pending = cache.get(key);
        if (!pending) { pending = checked(work); cache.set(key, pending); }
        // Attach immediately even when work synchronously stops its subscriber;
        // a second pre-await abort check would orphan pending's rejection.
        return pending.then(value => { signal?.throwIfAborted(); return value; });
    }
    const marketReferences = (market: Market, grader: string | null, grade: string | null) => {
        const { record, printing, finish } = market;
        const labels = titleDecidesPrinting(record.setName)
            ? [...new Set(record.variants.filter(variant => variant.finish === finish).map(variant => variant.name))]
            : [...new Set(market.labels)];
        const key = JSON.stringify([record.id, printing, finish, labels, grader, grade]);
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
                    if (page.nextCursor && !hasMatchedSales(accepted)) pending.push({ variant, cursor: page.nextCursor, stream: page.stream });
                } catch (error) {
                    signal?.throwIfAborted();
                    if (error instanceof StorageUnavailableError || error instanceof PriceResearchBudgetError && error.reason !== "LIMIT") throw error;
                    issue = error instanceof ScreeningPriceBudgetError || error instanceof PriceResearchBudgetError ? "BUDGET" : "UNAVAILABLE";
                    break;
                }
            }
            return { references: accepted, complete: issue === null, issue };
        });
    };

    return async (listing: ListingSummary, intent: SearchIntent): Promise<ScreeningSoldEvidence> => {
        signal?.throwIfAborted();
        const evidence: ScreeningSoldEvidence = { status: "UNAVAILABLE", exactScope: false, references: [], note: "The listing does not establish one exact card market for sold-price screening." };
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
        if (listing.isGraded && (specialSlab(listing.title) || titleGrader && listedGrader && titleGrader !== listedGrader ||
            titleGrade && listedGrade != null && Number(titleGrade) !== listedGrade)) return evidence;
        const grader = listing.isGraded ? listedGrader ?? titleGrader : null;
        const grade = listing.isGraded ? listedGrade == null ? titleGrade : String(listedGrade) : null;
        if (listing.isGraded && (!grader || !/^(?:PSA|CGC|BGS|SGC|TAG)$/.test(grader) || !grade || !/^(?:10|[1-9](?:\.5)?)$/.test(grade))) return evidence;
        try {
            const catalogKey = JSON.stringify([canonicalCatalogName(name), setFamily(set).sort(), normalizeCardNumber(number)]);
            const found = await memo(catalogs, catalogKey, () => source.lookupCards({ name, set, cardNumber: number ?? "" }));
            const matches = [...new Map(found.filter(record => record.source === "pkmnprices" && sameSetFamily(record.setName, set) && (!number || sameCardNumber(record.cardNumber, number)) && sameCatalogName(record.name, name)).map(record => [record.id, record])).values()];
            const identities = matches.map(record => JSON.stringify([normalizeSetName(record.setName), normalizeCardNumber(record.cardNumber)]));
            if (!matches.length || new Set(identities).size !== matches.length) return evidence;
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
            for (const market of markets.values()) {
                const result = await marketReferences(market, grader, grade);
                evidence.references.push(...result.references);
                if (!result.complete) return incompleteEvidence(evidence, result.issue === "BUDGET");
            }
            evidence.status = hasMatchedSales(evidence.references) ? "AVAILABLE" : "UNAVAILABLE";
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
            return incompleteEvidence(evidence, error instanceof ScreeningPriceBudgetError || error instanceof PriceResearchBudgetError);
        }
    };
}
