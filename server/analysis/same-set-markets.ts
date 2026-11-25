import { cardLanguageStatus } from "../../shared/card-language.ts";
import { normalizeCardNumber, sameCardNumber } from "../../shared/card-number.ts";
import { conditionGap, isRawCondition, type RawCondition } from "../../shared/conditions.ts";
import type { DealHuntGoal } from "../../shared/deal-hunt.ts";
import { finishClaim } from "../../shared/finish.ts";
import { isPrinting, readyForPricing } from "../../shared/identity.ts";
import { parseListingLink } from "../../shared/listing-link.ts";
import { money } from "../../shared/money/cents.ts";
import { isRawSoldPrice, isUsableRawPrice, rawPriceForPath, referencePriceReason, unsupportedVariantReason } from "../../shared/money/price-evidence.ts";
import { conflictsWithPhotoFinish, observedCardKind } from "../../shared/photo-evidence.ts";
import { hasBaseSetFourthPrint } from "../../shared/reprint-release.ts";
import { setKey } from "../../shared/sets.ts";
import { verifiedSlabMarketKey } from "../../shared/slab-market.ts";
import { median, soldMarketPrice } from "../../shared/sold-evidence.ts";
import { observedSoldSales, SALES_ACTIVITY_DAYS, SALES_ACTIVITY_MS } from "../../shared/sales-activity.ts";
import type { CompSale, CompSummary, Evaluation, Grader, PricedPath, Printing } from "../../shared/types.ts";
import { canonicalCatalogName } from "../identity/catalog-name.ts";
import { finishOfVariant } from "../identity/card-identity.ts";
import { compProblem, matchesSoldTarget, printingProblem } from "../pricing/sold-comps.ts";
import { confirmedHuntPage, savedHuntSaleRows } from "../pricing/saved-hunt-sales.ts";
import { readHuntEvaluations, recentHuntCardIndex } from "./private-evaluation.ts";
import { createSearchDiagnosticStore } from "./search-diagnostic-store.ts";

export interface HuntOrigin { name: string; set: string; cardNumber: string | null }
interface ObservedAsk { listingId: string; price: number; shipping: number; potentialGrade: number }
export interface HuntMarket {
    name: string; set: string; cardNumber: string; printing: Printing; finish: "HOLO" | "NON_HOLO" | "REVERSE_HOLO";
    kind: "slab" | "raw"; grader: string | null; grade: number | null; condition: RawCondition | null;
    sales30: number; sales60?: number; sales90: number; latestSaleAt: string; medianUsd: number; listingIds: string[]; projectedProfit: number | null;
    valueBasis?: "EBAY_SOLD" | "TCGPLAYER_OFFERS" | "TCGPLAYER_MARKET";
    quoteAsOf?: string;
    activityScope?: "PHOTO_CONDITION" | "SELLER_CONDITION" | "GRADE";
    /** Actual distinct transaction dates, so a long-running hunt can recount its window. */
    activityDates?: string[];
    /** Active fixed-price copies observed within the last day. Research leads only. */
    observedAsks?: ObservedAsk[];
    /** Legacy saved activity boundary. Never a purchase-volume requirement. */
    liquidThrough?: number;
}
type Scope = "same_set" | "any_card";
const day = 86_400_000;
interface CopyMarket {
    summary?: CompSummary; path?: PricedPath; condition: RawCondition | null; variant: string;
    price: number; basis: "EBAY_SOLD" | "TCGPLAYER_OFFERS" | "TCGPLAYER_MARKET"; quoteAsOf?: string;
    activityScope: "PHOTO_CONDITION" | "SELLER_CONDITION" | "GRADE";
}

function copyMarkets(value: Evaluation, goal: DealHuntGoal, slab: boolean, includeDownside = false): CopyMarket[] {
    const id = value.identity!;
    type PriceSource = { status: string; printing?: string; variant?: string };
    function matches<P extends PriceSource>(pricing: P | null | undefined): pricing is P & { variant: string } {
        return pricing?.status === "PRICED" && pricing.printing === id.printing && !!pricing.variant && finishOfVariant(pricing.variant) === id.finish;
    }
    const paths = (value.underwriting?.paths ?? []).filter((p): p is PricedPath => p.status === "PRICED" && !referencePriceReason(value, p));
    if (slab) {
        const pricing = value.slabPricing, summary = pricing?.summary, label = value.slab;
        if (!label || !matches(pricing) || !summary || !verifiedSlabMarketKey(value) ||
            pricing.grader !== label.grader || summary.grader !== label.grader ||
            String(pricing.grade) !== label.grade || String(summary.grade) !== label.grade) return [];
        if (goal === "grade_raw" && (!(label.grader === "PSA" || label.grader === "CGC") || !Number.isInteger(Number(label.grade)))) return [];
        const price = soldMarketPrice(summary);
        return price === null ? [] : [{ summary, price, basis: "EBAY_SOLD", activityScope: "GRADE",
            path: paths.find(path => path.path === "GRADED_RESALE"), condition: null, variant: pricing.variant }];
    }
    if (goal === "collect_slab" || value.condition?.authenticity?.concern !== "NONE_SEEN") return [];
    const result: CopyMarket[] = [];
    const condition = value.condition.rawCondition, raw = value.rawPricing;
    if (goal === "resell" && matches(raw) && isRawCondition(condition) && (!raw.finish || raw.finish === id.finish)) {
        const row = raw.prices?.find(row => row.condition === condition && isUsableRawPrice(row));
        const physical = row?.comps ?? raw.ebayComps?.find(s => s.grader === "RAW" && s.grade === condition && s.count > 0);
        const seller = raw.sellerConditionComps;
        const summary = seller?.grader === "RAW" && seller.grade === condition && seller.count > 0 ? seller
            : physical?.grader === "RAW" && physical.grade === condition ? physical : undefined;
        if (row) result.push({ summary, price: row.price, basis: row.basis?.startsWith("TCGPLAYER_") ? row.basis : "EBAY_SOLD",
            quoteAsOf: row.offers?.checkedAt, activityScope: summary === physical ? "PHOTO_CONDITION" : "SELLER_CONDITION", condition, variant: raw.variant,
            path: paths.find(path => path.path === "RAW" && path.priceCondition === condition && path.salePrice === row.price) });
    }
    const likely = value.condition.gradeRange?.likely;
    if (!likely) return result;
    for (const grader of ["PSA", "CGC"] satisfies Grader[]) {
        const pricing = value.gradedPricing?.[grader];
        if (!matches(pricing) || pricing.grader && pricing.grader !== grader) continue;
        for (const summary of pricing.byGrade ?? []) {
            const grade = Number(summary.grade);
            if (summary.grader !== grader || grade !== likely && !(includeDownside && grade === likely - 1)) continue;
            const price = soldMarketPrice(summary);
            if (price !== null) result.push({ summary, price, basis: "EBAY_SOLD", activityScope: "GRADE", condition: null,
                variant: pricing.variant, path: paths.find(path => path.path === "GRADE" && path.grader === grader) });
        }
    }
    return result;
}

function eligible(scope: Scope, origin: HuntOrigin | null) {
    return scope === "same_set" ? !!origin?.set.trim() && !!origin.name.trim() : scope === "any_card";
}

function inHuntScope(set: string, name: string, number: string, scope: Scope, origin: HuntOrigin | null) {
    if (!origin) return scope === "any_card";
    const sameSet = setKey(set) === setKey(origin.set);
    if (!sameSet) return scope === "any_card";
    return origin.cardNumber ? !sameCardNumber(origin.cardNumber, number) : canonicalCatalogName(name) !== canonicalCatalogName(origin.name);
}

export function rankHuntMarkets(evaluations: Evaluation[], origin: HuntOrigin | null, goal: DealHuntGoal, scope: Scope, now: number,
    includeDownside = false): HuntMarket[] {
    if (!eligible(scope, origin)) return [];
    type Market = Omit<HuntMarket, "sales30" | "sales60" | "sales90" | "latestSaleAt" | "medianUsd" | "listingIds" | "projectedProfit">;
    type Sale = { at: number; price: number };
    const groups = new Map<string, { market: Market; sales: Map<string, Sale>; copies: Map<string, number | null>; values: number[] }>();
    const transactions = new Map<string, { scope: string; at: number; price: number }>();
    const ambiguous = new Set<string>();
    for (const value of evaluations) {
        const id = value.identity, kind = observedCardKind(value);
        if (!id?.name || !id.set || !id.cardNumber || !isPrinting(id.printing) || !kind || !readyForPricing(id) || id.notThisCard ||
            id.finish !== "HOLO" && id.finish !== "REVERSE_HOLO" && id.finish !== "NON_HOLO" ||
            cardLanguageStatus(value.listing.title, [id.language, value.photoCheck?.cardIdentity?.language, value.listing.aspects?.Language]) !== "ENGLISH" ||
            unsupportedVariantReason(value) || conflictsWithPhotoFinish(value.photoCheck, id.finish) || hasBaseSetFourthPrint(id.set, value.listing.title)) continue;
        // A verified slab's completed sales can point a broad grading hunt to
        // another card. Its purchase terms cannot describe a raw acquisition.
        const useSlabSalesForRaw = kind === "graded" && goal === "grade_raw";
        if (useSlabSalesForRaw && scope !== "any_card") continue;
        const acquisitionKind = kind === "raw" || useSlabSalesForRaw ? "raw" : "slab";
        const set = setKey(id.set), name = canonicalCatalogName(id.name), number = normalizeCardNumber(id.cardNumber);
        if (!set || !name || number?.number == null || !inHuntScope(id.set, id.name, id.cardNumber, scope, origin)) continue;
        const { price, shipping, termsCheckedAt, endTime } = value.listing;
        const age = now - Date.parse(termsCheckedAt ?? "");
        const observedAsk = goal === "resell" && age >= 0 && age <= day && (!endTime || Date.parse(endTime) > now) &&
            price != null && Number.isFinite(price) && price > 0 && shipping != null && Number.isFinite(shipping) && shipping >= 0 &&
            !value.underwriting?.shippingUnconfirmed
            ? { listingId: value.listing.id, price, shipping, potentialGrade: Number(value.slab?.grade ?? value.condition?.gradeRange?.high ?? 0) }
            : null;
        for (const { summary, condition, path, variant, price: marketPrice, basis, quoteAsOf, activityScope } of copyMarkets(value, goal, kind === "graded", includeDownside)) {
            const observations = observedSoldSales(summary?.activitySales ?? summary?.sales ?? [], now, { slab: !condition,
                maxDays: summary?.windowDays === 180 ? 180 : 90 }).filter(({ sale }) =>
                !(condition && activityScope === "PHOTO_CONDITION" && sale.photoCondition !== condition) &&
                !hasBaseSetFourthPrint(id.set, sale.title));
            if (!basis.startsWith("TCGPLAYER_") && !observations.length) continue;
            const grader = condition ? null : summary!.grader, grade = condition ? null : Number(summary!.grade);
            const saleScope = JSON.stringify([set, number, name, id.printing, id.finish, grader, grade, condition]);
            const key = JSON.stringify([saleScope, acquisitionKind]);
            let group = groups.get(key);
            if (!group) {
                group = { market: { set: id.set, cardNumber: id.cardNumber, name: id.name, printing: id.printing, finish: id.finish,
                    kind: acquisitionKind, grader, grade, condition, valueBasis: basis, quoteAsOf, activityScope }, sales: new Map(), copies: new Map(), values: [] };
                groups.set(key, group);
            }
            group.values.push(marketPrice);
            if (!useSlabSalesForRaw && value.listing.buyingOption === "FIXED_PRICE" && value.listing.availability === "ACTIVE") {
                group.copies.set(value.listing.id, path && Number.isFinite(path.profit) && !value.underwriting?.shippingUnconfirmed ? path.profit : null);
                if (observedAsk && path) (group.market.observedAsks ??= []).push(observedAsk);
            }
            // Saved eBay sold summaries are in USD. Reject explicit conflicting currency
            // on older records and require a linkable sale rather than counting provider totals.
            for (const { sale, id: saleId, at } of observations) {
                if (useSlabSalesForRaw) {
                    const target = { name: id.name, setName: id.set, cardNumber: id.cardNumber, requireTitleIdentity: true };
                    const finish = finishClaim(sale.title);
                    if (!matchesSoldTarget(sale, target, grader, String(grade)) || printingProblem({ title: sale.title, variant }, id.printing, id.set) ||
                        finish !== "NOT_STATED" && finish !== id.finish) continue;
                }
                const previous = transactions.get(saleId);
                if (previous && (previous.scope !== saleScope || previous.at !== at || previous.price !== sale.price)) ambiguous.add(saleId);
                transactions.set(saleId, { scope: saleScope, at, price: sale.price });
                group.sales.set(saleId, { at, price: sale.price });
            }
        }
    }
    const ranked: HuntMarket[] = [];
    for (const { market, sales, copies, values } of groups.values()) {
        const verified = [...sales].filter(([id]) => !ambiguous.has(id)).map(([, sale]) => sale);
        const recent = verified.filter(sale => now - sale.at <= SALES_ACTIVITY_MS).sort((a, b) => b.at - a.at);
        // Activity describes observed transactions. It cannot veto a supported
        // value quote, and zero observations never becomes invented volume.
        if (!values.length || !verified.length && !market.valueBasis?.startsWith("TCGPLAYER_")) continue;
        const listings = [...copies].sort((a, b) => (b[1] ?? -Infinity) - (a[1] ?? -Infinity) || a[0].localeCompare(b[0]));
        ranked.push({ ...market, sales30: recent.filter(s => now - s.at <= 30 * day).length, sales60: recent.length,
            sales90: verified.filter(s => now - s.at <= 90 * day).length, medianUsd: money(median(values)),
            activityDates: verified.map(sale => new Date(sale.at).toISOString()),
            latestSaleAt: verified.length ? new Date(Math.max(...verified.map(sale => sale.at))).toISOString() : "",
            listingIds: listings.map(([id]) => id), projectedProfit: listings[0]?.[1] ?? null });
    }
    return ranked.sort((a, b) => (goal === "resell" ? (b.projectedProfit ?? 0) - (a.projectedProfit ?? 0) : 0) ||
        (b.sales60 ?? b.sales30) - (a.sales60 ?? a.sales30) || b.sales90 - a.sales90 || b.latestSaleAt.localeCompare(a.latestSaleAt) || a.name.localeCompare(b.name));
}

export function verifiedRawFloor(value: Evaluation, path: PricedPath, now: number) {
    const assessed = value.condition?.rawCondition, condition = path.priceCondition;
    const raw = value.rawPricing, identity = value.identity;
    if (path.path !== "RAW" || !isRawCondition(assessed) || !isRawCondition(condition) || conditionGap(assessed, condition) <= 0 ||
        !readyForPricing(identity) || raw?.status !== "PRICED" || raw.printing !== identity?.printing || !(raw.finish || raw.variant) ||
        raw.finish && raw.finish !== identity?.finish || raw.variant && finishOfVariant(raw.variant) !== identity?.finish) return null;
    const row = rawPriceForPath(raw, path);
    if (!row || !isRawSoldPrice(row)) return null;
    const summary = row.comps ?? raw.ebayComps?.find(entry => entry.grader === "RAW" && entry.grade === condition);
    if (!summary?.count || summary.grader !== "RAW" || summary.grade !== condition || soldMarketPrice(summary) !== row.price ||
        !summary.sales.length || summary.sales.some(sale => sale.photoCondition !== condition || !sale.conditionEvidence?.length)) return null;
    const comparisons = observedSoldSales(summary.sales, now, { maxDays: summary.windowDays === 180 ? 180 : 90 });
    return comparisons.length === summary.sales.length ? { row, summary } : null;
}

export function salesForExit(value: Evaluation, path: PricedPath, markets: HuntMarket[], now: number) {
    const id = value.identity;
    if (!id?.name || !id.set || !id.cardNumber) return 0;
    if (path.path === "RAW" && path.priceCondition !== value.condition?.rawCondition) {
        const floor = verifiedRawFloor(value, path, now);
        return observedSoldSales(floor?.summary.activitySales ?? floor?.summary.sales ?? [], now, { maxDays: SALES_ACTIVITY_DAYS })
            .filter(({ sale }) => sale.photoCondition === path.priceCondition && sale.conditionEvidence?.length).length;
    }
    const slab = path.path === "GRADED_RESALE";
    const grade = slab ? Number(value.slab?.grade) : value.condition?.gradeRange?.likely;
    const grader = slab ? value.slab?.grader : path.grader;
    const matching = markets.filter(market => canonicalCatalogName(market.name) === canonicalCatalogName(id.name) &&
        setKey(market.set) === setKey(id.set!) && sameCardNumber(market.cardNumber, id.cardNumber) &&
        market.printing === id.printing && market.finish === id.finish && market.kind === (slab ? "slab" : "raw") &&
        (path.path === "RAW" ? market.condition === value.condition?.rawCondition && market.condition === path.priceCondition && market.grader === null :
            market.condition === null && market.grader === grader && market.grade === grade));
    // A copy's own sales may already appear in discovery's market, so never add counts.
    return Math.max(0, ...matching.map(market => market.activityDates
        ? market.activityDates.filter(date => { const age = now - Date.parse(date); return age >= 0 && age <= SALES_ACTIVITY_MS; }).length
        : market.sales60 ?? market.sales30));
}

const index = createSearchDiagnosticStore();

export async function restoreSavedHuntSales(evaluations: Evaluation[], goal: DealHuntGoal, now: number, signal?: AbortSignal, read = savedHuntSaleRows) {
    const roots = new Map<string, Set<string>>();
    const retained: { root: string; listingId: string; sale: CompSale; identity: NonNullable<Evaluation["identity"]>; market: CopyMarket }[] = [];
    for (const value of evaluations) {
        const id = value.identity, kind = observedCardKind(value);
        if (!id?.recordId || !id.name || !kind || !readyForPricing(id) || id.notThisCard) continue;
        for (const market of copyMarkets(value, goal, kind === "graded", true)) {
            const { summary, condition, variant } = market;
            if (!summary) continue;
            const root = confirmedHuntPage(id.recordId, variant, condition ? null : summary.grader, condition ? null : summary.grade);
            for (const sale of summary?.sales ?? []) {
                const link = parseListingLink(sale.url), age = now - Date.parse(sale.soldAt);
                if (sale.saleType || !link || !(age >= 0 && age <= 90 * day) || condition && sale.photoCondition !== condition) continue;
                const ids = roots.get(root) ?? new Set();
                ids.add(link.itemId);
                roots.set(root, ids);
                retained.push({ root, listingId: link.itemId, sale, identity: id, market });
            }
        }
    }
    const confirmations = await read(roots, now, signal);
    for (const { root, listingId, sale, identity, market } of retained) {
        const native = confirmations.get(root)?.get(listingId);
        if (!native?.sale_type || native.currency !== "USD" || native.price !== sale.price ||
            typeof native.sold_at !== "string" || native.sold_at.slice(0, 10) !== sale.soldAt.slice(0, 10)) continue;
        const { grader, grade } = market.summary!;
        const raw = !!market.condition;
        if (raw && (native.grader || native.grade)) continue;
        const comp = raw ? { ...native, grader, grade: String(grade) } : native;
        if (compProblem(comp, { now, windowDays: 90, printing: identity.printing, setName: identity.set, cardName: identity.name,
            cardNumber: identity.cardNumber, finish: identity.finish, grader, grade }) ||
            !matchesSoldTarget(native, { name: identity.name!, setName: identity.set, cardNumber: identity.cardNumber }, raw ? null : grader, raw ? null : String(grade))) continue;
        // These are detached copies of saved evaluations. Persisted research stays intact.
        sale.saleType = native.sale_type;
    }
}

export async function findHuntMarkets(origin: HuntOrigin | null, goal: DealHuntGoal, scope: Scope, signal?: AbortSignal, acceptsSet: (set: string) => boolean = () => true): Promise<HuntMarket[]> {
    if (!eligible(scope, origin)) return [];
    signal?.throwIfAborted();
    const [cards, diagnostics] = await Promise.all([recentHuntCardIndex(), index.recentAssessedListingIds()]);
    const byCard = new Map<string, string[]>();
    for (const row of cards) {
        if (!row.card || !row.cardSet || !row.cardNumber || !row.listingId || !acceptsSet(row.cardSet)) continue;
        if (!inHuntScope(row.cardSet, row.card, row.cardNumber, scope, origin)) continue;
        const key = JSON.stringify([setKey(row.cardSet), normalizeCardNumber(row.cardNumber), canonicalCatalogName(row.card)]);
        const copies = byCard.get(key) ?? [];
        copies.push(row.listingId);
        byCard.set(key, copies);
    }
    // Read a copy of each card before spending storage reads on another copy of
    // the same card. Backfill from older completed searches and the file store.
    const selected = new Set<string>();
    for (let i = 0; i < 150 && selected.size < 150 && byCard.size; i++) {
        for (const [card, copies] of byCard) {
            if (copies[i]) selected.add(copies[i]);
            else byCard.delete(card);
            if (selected.size === 150) break;
        }
    }
    const ids = [...new Set([...selected, ...diagnostics])];
    const evaluations: Evaluation[] = [], now = Date.now();
    for (let i = 0; i < ids.length; i += 16) {
        signal?.throwIfAborted();
        for (const evaluation of await readHuntEvaluations(ids.slice(i, i + 16), now)) {
            const id = evaluation.identity;
            if (id?.set && acceptsSet(id.set) && id.name && id.cardNumber && inHuntScope(id.set, id.name, id.cardNumber, scope, origin)) evaluations.push(evaluation);
        }
    }
    signal?.throwIfAborted();
    await restoreSavedHuntSales(evaluations, goal, now, signal);
    return rankHuntMarkets(evaluations, origin, goal, scope, now);
}
