import { isRawCondition } from "../../shared/conditions.ts";
import { parseListingLink } from "../../shared/listing-link.ts";
import { SALES_ACTIVITY_MS } from "../../shared/sales-activity.ts";
import { median, rawPriceDeviation } from "../../shared/sold-evidence.ts";
import type { Evaluation, RawPricing, SlabPricing } from "../../shared/types.ts";
import { checkComps } from "../ai/comp-checker.ts";
import { createSoldConditionAcquirer } from "../ai/sold-condition.ts";
import { mergeFamily, sameCardNumber, sameSetFamily } from "../identity/card-identity.ts";
import { sameCatalogName } from "../identity/catalog-name.ts";
import { fetchComps, fetchRawComps, pricingRecord } from "./pkmnprices.ts";
import { rawPricesWithSales } from "./raw-comps.ts";
import { variantFor } from "./raw-prices.ts";
import { compProblem, matchesSoldTarget, summarizeComps, uniqueSoldComps } from "./sold-comps.ts";
import { supplementalMarket } from "./supplemental-research.ts";
import type { Comp } from "./types.ts";

export interface SoldCitation { url: string; priceUsd: number; date: string | null }

export function citedTransactions(value: Evaluation, guide: SoldCitation[], now: number) {
    const observations = value.webPriceResearch?.observations.filter(row => row.kind === "SOLD") ?? [];
    const facts = new Map<string, SoldCitation>();
    const conflicts = new Set<string>();
    for (const row of [...observations, ...guide]) {
        const link = parseListingLink(row.url);
        const age = now - Date.parse(row.date ?? "");
        if (!link || !link.itemId.endsWith("|0") || link.itemId === parseListingLink(value.listing.id)?.itemId ||
            !(age >= 0 && age <= SALES_ACTIVITY_MS) || !(Number.isFinite(row.priceUsd) && row.priceUsd > 0)) continue;
        const fact = { ...row, date: new Date(Date.parse(row.date!)).toISOString().slice(0, 10), url: link.url };
        const previous = facts.get(link.itemId);
        if (previous && (previous.date !== fact.date || previous.priceUsd !== fact.priceUsd)) conflicts.add(link.itemId);
        facts.set(link.itemId, fact);
    }
    for (const id of conflicts) facts.delete(id);
    return facts;
}

const sources = { record: pricingRecord, raw: fetchRawComps, graded: fetchComps, soldPhotos: createSoldConditionAcquirer, checkComps };
type PricingUpdate = { rawPricing: RawPricing } | { slabPricing: SlabPricing };

// Citations identify transactions to investigate. The marketplace record supplies
// the accepted amount, date and sale type. Only a matching reviewed copy can price the exit.
export async function verifyCitedSales(value: Evaluation, citations: ReadonlyMap<string, SoldCitation>, now: number,
    signal?: AbortSignal, deps = sources): Promise<PricingUpdate | null> {
    const id = value.identity, market = supplementalMarket(value, true);
    if (!citations.size || !id?.recordId || !id.name || !id.set || !id.cardNumber || !market || market.provisional !== null) return null;
    const record = await deps.record(String(id.recordId));
    if (!record || String(record.id) !== String(id.recordId) || !sameCatalogName(record.name, id.name) ||
        !sameSetFamily(record.setName, id.set) || !sameCardNumber(record.cardNumber, id.cardNumber)) return null;
    const card = mergeFamily([record]), variant = variantFor(card, id).variant;
    if (!variant) return null;
    const { grader, grade } = market.market;
    const raw = grader === "RAW", wear = value.condition?.rawCondition;
    const records = raw ? await deps.raw(variant.recordId, variant.name)
        : await deps.graded(variant.recordId, { grader, grade, variant: variant.name });
    signal?.throwIfAborted();
    const criteria = { printing: id.printing, setName: variant.setName, cardName: id.name, cardNumber: id.cardNumber,
        finish: variant.finish, grader, grade: raw ? "ANY" : grade, now, windowDays: 90 as const };
    const target = { name: id.name, setName: variant.setName, cardNumber: id.cardNumber, requireTitleIdentity: true };
    const byListing = new Map<string, Comp>(), conflicts = new Set<string>();
    for (const sale of uniqueSoldComps(records)) {
        const key = parseListingLink(sale.listing_url)?.itemId;
        if (!key || !key.endsWith("|0") || key === parseListingLink(value.listing.id)?.itemId) continue;
        const previous = byListing.get(key);
        if (previous && (previous.price !== sale.price || previous.sold_at !== sale.sold_at || previous.sale_type !== sale.sale_type ||
            previous.variant !== sale.variant || previous.title !== sale.title || previous.grade !== sale.grade || previous.grader !== sale.grader ||
            previous.grade_qualifier !== sale.grade_qualifier || previous.attribution !== sale.attribution || previous.currency !== sale.currency)) conflicts.add(key);
        byListing.set(key, sale);
    }
    for (const key of conflicts) byListing.delete(key);
    const rows = [...byListing.values()].filter(sale => sale.currency === "USD" && matchesSoldTarget(sale, target, raw ? null : grader, raw ? null : grade) &&
        (!raw || !sale.grader && !sale.grade && !/\b(?:psa|cgc|bgs|sgc|tag|lot|bundle)\b/i.test(sale.title)) &&
        !compProblem(raw ? { ...sale, grader, grade: "ANY" } : sale, criteria));
    const cited = (sale: Comp) => {
        const lead = citations.get(parseListingLink(sale.listing_url)!.itemId);
        return lead?.priceUsd === sale.price && lead.date === new Date(sale.sold_at).toISOString().slice(0, 10);
    };
    const candidates = rows.filter(cited).sort((a, b) => Date.parse(b.sold_at) - Date.parse(a.sold_at));
    if (!candidates.length) return null;
    const verifiesCitation = (url: string | null) => candidates.some(row => parseListingLink(row.listing_url)?.itemId === parseListingLink(url)?.itemId);
    if (!raw) {
        const verdicts = await deps.checkComps(rows, { cardName: id.name, setName: id.set, cardNumber: id.cardNumber,
            printingLabel: id.printingLabel ?? id.printing, finish: id.finish, grader, grade }, signal);
        const summary = summarizeComps(rows.filter(row => verdicts.has(row)), criteria, verdicts);
        if (!summary.sales.some(sale => verifiesCitation(sale.url))) return null;
        return { slabPricing: { ...value.slabPricing, source: record.source, variant: variant.name, printing: id.printing, grader, grade,
            status: "PRICED", reason: undefined, summary } };
    }
    if (!isRawCondition(wear)) return null;
    const photo = deps.soldPhotos({ condition: wear, now: () => now });
    const assessed = new Map<Comp, Awaited<ReturnType<typeof photo.acquire>>>();
    for (const sale of candidates) {
        signal?.throwIfAborted();
        const reading: Awaited<ReturnType<typeof photo.acquire>> = await photo.read(sale, id, signal) ??
            await deps.soldPhotos({ condition: wear, now: () => now }).acquire(sale, id, signal);
        assessed.set(sale, reading);
        if (reading?.condition === wear) break;
    }
    if (![...assessed.values()].some(evidence => evidence?.condition === wear)) return null;
    const marketPrices = await rawPricesWithSales(card, id, { now, signal, requestedCondition: wear, propagateErrors: true, fetchRawComps: async () => rows,
        assessCondition: (sale, target, active) => assessed.has(sale) ? Promise.resolve(assessed.get(sale) ?? null) : photo.read(sale, target, active),
        conditionStatus: photo.status });
    const price = marketPrices.prices?.find(p => p.condition === wear);
    if (!price?.comps?.sales.some(sale => verifiesCitation(sale.url))) return null;
    // A lone photographed premium cannot override a cluster of cheaper copies claiming the same wear.
    const cohort = marketPrices.sellerConditionComps?.activitySales ?? marketPrices.sellerConditionComps?.sales ?? [];
    if (cohort.length >= 3) {
        const amounts = cohort.map(sale => sale.price), center = median(amounts);
        if (price.price > center + rawPriceDeviation(amounts, center)) return null;
    }
    return { rawPricing: { ...value.rawPricing, ...marketPrices,
        prices: [...(value.rawPricing?.prices ?? []).filter(p => p.condition !== wear), price],
        ebayComps: [...(value.rawPricing?.ebayComps ?? []).filter(s => s.grade !== wear), price.comps], soldPhotoDeferred: undefined } };
}
