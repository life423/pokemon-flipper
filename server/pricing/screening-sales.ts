import { readTitleByRules } from "../ai/title-reader.ts";
import { isPrinting, normalizeCardNumber, normalizeSetName, normalizeWords, printingClaimFromText, sameCardNumber, sameSetFamily, setFamily, titleDecidesPrinting } from "../identity/card-identity.ts";
import { finishClaim } from "../../shared/finish.ts";
import { RAW_CONDITIONS } from "../../shared/conditions.ts";
import { StorageUnavailableError } from "../storage/index.ts";
import type { ListingSummary, ScreeningSoldEvidence, ScreeningSoldReference, SearchIntent } from "../../shared/types.ts";
import type { CardRecord, Comp, FetchComps, FetchRawComps, LookupCards } from "./types.ts";
import { compCondition } from "./raw-comps.ts";
import { compProblem, summarizeComps, type CompCriteria } from "./sold-comps.ts";
import { createScreeningPriceSource, ScreeningPriceBudgetError } from "./pkmnprices.ts";

type Source = { lookupCards: LookupCards; fetchComps: FetchComps; fetchRawComps: FetchRawComps };
type Finish = ScreeningSoldReference["finish"];
interface Market { record: CardRecord; printing: ScreeningSoldReference["printing"]; finish: Finish; labels: string[] }
interface MarketEvidence { references: ScreeningSoldReference[]; complete: boolean; issue: "BUDGET" | "UNAVAILABLE" | null }
const FINISHES = ["HOLO", "NON_HOLO", "REVERSE_HOLO"];
const DAY_MS = 86_400_000;
const ordinarySale = (sale: Comp) => !/\blot\b|\bbundle\b|\bset of\b|\b\d+\s*(?:cards|pcs)\b|\bsigned\b|\bautograph(?:ed)?\b|\baltered\b|\bcustom\b|\bproxy\b|\breplica\b|\bmiscut\b|\bcrimp\b|\bholo\s*bleed\b|\bdouble\s*holo\b/i.test(sale.title);
const specialSlab = (title: string) => /\((?:oc|mk|mc|st|pd|of)\)|\b(?:pristine|black label|perfect|altered|qualified|qualifier|authentic(?:ated)?)\b/i.test(title);
const unique = (sales: Comp[]) => [...new Map(sales.map(sale => [sale.id ?? sale.listing_url ?? `${sale.title}|${sale.sold_at}|${sale.price}`, sale])).values()];
// Preserve a negative edition claim as metadata rather than leaving "no"
// attached to the name after the literal reader removes "1st Edition".
const readClaims = (title: string) => readTitleByRules(title.replace(/\b(?:no|not|without|non)[\s-]*(?:1st|first)[\s-]*ed(?:ition|it)?\b/gi, "Unlimited"));
function matchesSaleTarget(sale: Comp, record: CardRecord, grader: string | null, grade: string | null) {
    const reading = readClaims(sale.title);
    return !(reading.kind && reading.kind !== "SINGLE_CARD" || reading.language === "Other" ||
        reading.cardName && normalizeWords(reading.cardName) !== normalizeWords(record.name) ||
        reading.set && !sameSetFamily(reading.set, record.setName) ||
        reading.cardNumber && !sameCardNumber(reading.cardNumber, record.cardNumber) ||
        grader && reading.grader && reading.grader !== grader ||
        grade && reading.grade && Number(reading.grade) !== Number(grade));
}
function incompleteEvidence(evidence: ScreeningSoldEvidence, budget: boolean): ScreeningSoldEvidence {
    const useful = evidence.references.some(reference => reference.summary.count >= 3);
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
    const pages = new Map<string, Promise<Comp[]>>();
    const references = new Map<string, Promise<MarketEvidence>>();
    const checked = async <T>(work: () => Promise<T>) => { signal?.throwIfAborted(); const value = await work(); signal?.throwIfAborted(); return value; };
    function memo<T>(cache: Map<string, Promise<T>>, key: string, work: () => Promise<T>) {
        let pending = cache.get(key);
        if (!pending) { pending = checked(work); cache.set(key, pending); }
        return checked(() => pending!);
    }
    const marketReferences = (market: Market, grader: string | null, grade: string | null) => {
        const { record, printing, finish } = market;
        const labels = titleDecidesPrinting(record.setName)
            ? [...new Set(record.variants.filter(variant => variant.finish === finish).map(variant => variant.name))]
            : market.labels;
        const key = JSON.stringify([record.id, printing, finish, labels, grader, grade]);
        return memo(references, key, async () => {
            const sales: Comp[] = [];
            let issue: MarketEvidence["issue"] = null;
            for (const variant of labels) {
                const pageKey = JSON.stringify([record.id, variant, grader, grade]);
                try {
                    sales.push(...await memo(pages, pageKey, () => grader && grade
                        ? source.fetchComps(record.id, { grader, grade, variant }) : source.fetchRawComps(record.id, variant)));
                } catch (error) {
                    signal?.throwIfAborted();
                    if (error instanceof StorageUnavailableError) throw error;
                    issue = error instanceof ScreeningPriceBudgetError ? "BUDGET" : "UNAVAILABLE";
                    break;
                }
            }
            const result = (accepted: ScreeningSoldReference[]): MarketEvidence => ({ references: accepted, complete: issue === null, issue });
            const eligible = unique(sales).filter(sale => sale.currency === "USD" && ordinarySale(sale) && matchesSaleTarget(sale, record, grader, grade));
            const base = { recordId: record.id, name: record.name, set: record.setName!, cardNumber: record.cardNumber, printing, finish };
            if (grader && grade) {
                const ordinary = eligible.filter(sale => !specialSlab(sale.title));
                const criteria: CompCriteria = { printing, setName: record.setName, finish, grader, grade, now: asOf };
                const recent = ordinary.filter(sale => compProblem(sale, criteria) === null && asOf - Date.parse(sale.sold_at) <= 90 * DAY_MS);
                const summary = summarizeComps(ordinary, { ...criteria, windowDays: recent.length >= 3 ? 90 : 180 });
                return result(summary.count ? [{ ...base, grader, grade, condition: null, summary }] : []);
            }
            const raw = eligible.filter(sale => !sale.grader && !sale.grade && !/\b(?:psa|cgc|bgs|sgc|tag)\b/i.test(sale.title));
            const accepted = RAW_CONDITIONS.flatMap<ScreeningSoldReference>(condition => {
                const matching = raw.filter(sale => compCondition(sale.title) === condition).map(sale => ({ ...sale, grader: "RAW", grade: condition }));
                const summary = summarizeComps(matching, { printing, setName: record.setName, finish, grader: "RAW", grade: condition, now: asOf, windowDays: 90 });
                return summary.count ? [{ ...base, grader: null, grade: null, condition, summary }] : [];
            });
            // Unstated condition is useful market context for deciding whether
            // to inspect a card, never a condition-specific resale valuation.
            const unspecified = raw.filter(sale => compCondition(sale.title) === null).map(sale => ({ ...sale, grader: "RAW", grade: "UNSPECIFIED" }));
            const summary = summarizeComps(unspecified, { printing, setName: record.setName, finish, grader: "RAW", grade: "UNSPECIFIED", now: asOf, windowDays: 90 });
            if (summary.count) accepted.push({ ...base, grader: null, grade: null, condition: null, summary });
            return result(accepted);
        });
    };

    return async (listing: ListingSummary, intent: SearchIntent): Promise<ScreeningSoldEvidence> => {
        signal?.throwIfAborted();
        const evidence: ScreeningSoldEvidence = { status: "UNAVAILABLE", exactScope: false, references: [], note: "The listing does not establish one exact card market for sold-price screening." };
        const reading = readClaims(listing.title), card = listing.screen?.card;
        if (reading.kind && reading.kind !== "SINGLE_CARD") return evidence;
        const claimedNames = [card?.name, reading.cardName].filter((value): value is string => Boolean(value?.trim()));
        const claimedSets = [card?.set, reading.set].filter((value): value is string => Boolean(value?.trim()));
        const claimedNumbers = [card?.cardNumber, reading.cardNumber].filter((value): value is string => Boolean(value?.trim()));
        if (new Set(claimedNames.map(normalizeWords)).size > 1 ||
            claimedSets.some(value => !sameSetFamily(value, claimedSets[0]) && !sameSetFamily(claimedSets[0], value)) ||
            claimedNumbers.some(value => !sameCardNumber(value, claimedNumbers[0]))) return evidence;
        const name = claimedNames[0] ?? intent.cardName;
        const set = claimedSets[0] ?? (intent.sets.length === 1 ? intent.sets[0] : null);
        const number = claimedNumbers[0] ?? intent.cardNumber;
        if (!name || !set) return evidence;
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
            const catalogKey = JSON.stringify([normalizeWords(name), setFamily(set).sort(), normalizeCardNumber(number)]);
            const found = await memo(catalogs, catalogKey, () => source.lookupCards({ name, set, cardNumber: number ?? "" }));
            const matches = [...new Map(found.filter(record => record.source === "pkmnprices" && sameSetFamily(record.setName, set) && (!number || sameCardNumber(record.cardNumber, number)) && normalizeWords(record.name) === normalizeWords(name)).map(record => [record.id, record])).values()];
            const identities = matches.map(record => JSON.stringify([normalizeSetName(record.setName), normalizeCardNumber(record.cardNumber)]));
            if (!matches.length || new Set(identities).size !== matches.length) return evidence;
            const markets = new Map<string, Market>();
            let unknownVariant = false;
            for (const record of matches) for (const variant of record.variants) {
                if (!isPrinting(variant.printing) || !FINISHES.includes(variant.finish)) { unknownVariant = true; continue; }
                if (printing && variant.printing !== printing || finish && variant.finish !== finish) continue;
                const key = JSON.stringify([record.id, variant.printing, variant.finish]);
                const market = markets.get(key) ?? { record, printing: variant.printing, finish: variant.finish as Finish, labels: [] };
                market.labels.push(variant.name); markets.set(key, market);
            }
            if (!markets.size) return evidence;
            evidence.exactScope = !intentOnly && markets.size === 1 && (!unknownVariant || Boolean(printing && finish));
            for (const market of markets.values()) {
                const result = await marketReferences(market, grader, grade);
                evidence.references.push(...result.references);
                if (!result.complete) return incompleteEvidence(evidence, result.issue === "BUDGET");
            }
            evidence.status = evidence.references.some(reference => reference.summary.count >= 3) ? "AVAILABLE" : "UNAVAILABLE";
            evidence.note = evidence.status === "AVAILABLE"
                ? listing.isGraded ? "Recent matched sold amounts for the listed exact grader and grade; the photographed label is not yet verified."
                    : "Recent matched raw sold amounts stay in separate seller-condition buckets. Unstated-condition sales provide market context only, never a condition-specific resale value or grade. These references do not assess this listing's condition or grading upside."
                : "Fewer than three matched recent sales support any requested market. Sparse observations remain visible without inventing a price.";
            if (!evidence.exactScope) evidence.note += " Listing claims do not settle one market; possible printings and finishes remain separate.";
            return structuredClone(evidence);
        } catch (error) {
            signal?.throwIfAborted();
            if (error instanceof StorageUnavailableError) throw error;
            return incompleteEvidence(evidence, error instanceof ScreeningPriceBudgetError);
        }
    };
}
