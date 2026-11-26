import { listingMarketPrices, screeningSaleGroups, type ProviderPrice } from "../../shared/listing-market-prices.ts";
import { CONDITION_NAMES, isRawCondition } from "../../shared/conditions.ts";
import { finishClaim } from "../../shared/finish.ts";
import { observedCardKind } from "../../shared/photo-evidence.ts";
import { rawPriceReferences } from "../../shared/money/raw-buy-guidance.ts";
import type { CardmarketComparison } from "../../shared/cardmarket.ts";
import type { Evaluation } from "../../shared/types.ts";
import { mapVariantPrintings, mergeFamily, sameCardNumber, sameSetFamily } from "../identity/card-identity.ts";
import { sameCatalogName } from "../identity/catalog-name.ts";
import { supplementalResearch } from "./supplemental-research.ts";
import { compareCardmarket } from "./cardmarket.ts";
import { cardmarketRecord, createScreeningPriceSource } from "./pkmnprices.ts";
import { marketSummaries } from "./screening-sales.ts";
import { tcgplayerRawPrice } from "./tcgplayer-raw.ts";
import { sourceUrl } from "../ai/web-price-research.ts";
import { storageFailure } from "../lib/storage-failure.ts";
import { PriceResearchBudgetError, withPriceResearchSignal } from "./research-budget.ts";

const day = 86_400_000;

export function providerPrices(value: Evaluation, now: number, european?: CardmarketComparison): ProviderPrice[] {
    const id = value.identity;
    if (!id) return [];
    const prices: ProviderPrice[] = [];
    function add(source: string, basis: string, price: number, asOf: string, validUntil: number, currency: "USD" | "EUR" = "USD", url?: string) {
        if (Number.isFinite(price) && price > 0 && Date.parse(asOf) <= now && now < validUntil)
            prices.push({ source, basis, price, asOf, validUntil, currency, ...(url && { url }) });
    }

    const raw = observedCardKind(value) === "raw", wear = value.condition?.rawCondition;
    const slab = value.slab;
    if (raw && isRawCondition(wear)) {
        const { tracked } = rawPriceReferences(value, now, wear, id);
        if (tracked?.condition === wear) add("Pokémon Price Tracker", "TCGplayer market", tracked.priceUsd, tracked.updatedAt, Date.parse(tracked.updatedAt) + 7 * day);
    } else if (slab) {
        const tracker = value.trackerPriceReference, grade = tracker?.gradedMarket, label = tracker?.printingLabel;
        const finish = finishClaim(label);
        if (grade && label && grade.grader === slab.grader && grade.grade === slab.grade && grade.reportedSales > 0 &&
            mapVariantPrintings([label], id.set)[label] === id.printing && (finish === "NOT_STATED" ? "NON_HOLO" : finish) === id.finish) {
            const at = Date.parse(grade.lastSaleAt), weekly = grade.statistic === "7_DAY_MEDIAN";
            add("Pokémon Price Tracker", weekly ? "7-day sold median" : "Historical sold median", grade.priceUsd, grade.lastSaleAt, at + (weekly ? 7 : 90) * day);
            const filtered = grade.filteredEstimate;
            if (filtered && Number.isInteger(filtered.days) && filtered.days > 0 && filtered.days <= 90)
                add("Pokémon Price Tracker", filtered.days + "-day provider estimate", filtered.priceUsd, grade.lastSaleAt, at + filtered.days * day);
        }
        const pricing = value.slabPricing, ask = pricing?.activeReference;
        if (ask && pricing?.printing === id.printing && ask.grade === slab.grade && ask.grader === slab.grader && ask.listings.length) {
            const expires = Date.parse(ask.checkedAt) + 120_000;
            add("eBay", "Lowest matched ask with shipping", ask.lowestTotal, ask.checkedAt, expires);
            add("eBay", "Resale estimate from active asks", ask.resalePrice, ask.checkedAt, expires);
        }
    }

    const web = value.webPriceResearch, market = web?.market;
    if (web && market && market.cardName === id.name && market.cardNumber === id.cardNumber && market.setName === id.set &&
        market.language === id.language && market.finish === id.finish && market.printingLabel === (id.printingLabel || id.printing.replaceAll("_", " ")) &&
        market.grader === (raw ? "RAW" : slab?.grader) && market.grade === (raw && isRawCondition(wear) ? CONDITION_NAMES[wear] : slab?.grade) &&
        Date.parse(web.checkedAt) <= now) {
        for (const row of web.observations) {
            const citation = sourceUrl(row.url);
            if (!citation || row.kind === "SOLD" && !row.date) continue;
            const url = new URL(citation);
            const date = row.date || web.checkedAt, expires = Math.min(Date.parse(web.checkedAt) + 7 * day, Date.parse(date) + (row.kind === "SOLD" ? 90 : 7) * day);
            add("Cited web price", url.hostname.replace(/^www\./, "") + (row.kind === "SOLD" ? " sale" : " ask"), row.priceUsd, date, expires, "USD", url.href);
        }
    }
    if (european?.status === "AVAILABLE" && Date.parse(european.checkedAt) <= now) {
        const cheapest = european.offers.filter(row => Date.parse(row.updatedAt) <= now && now < Date.parse(row.updatedAt) + 7 * day)
            .sort((a, b) => a.priceEur - b.priceEur)[0];
        if (cheapest) add("Cardmarket", "Lowest ask before shipping", cheapest.priceEur, cheapest.updatedAt,
            Math.min(Date.parse(european.checkedAt) + 6 * 3_600_000, Date.parse(cheapest.updatedAt) + 7 * day), "EUR");
    }
    return prices;
}

async function recentSales(value: Evaluation, signal: AbortSignal, now: number) {
    const id = value.identity;
    if (!id?.recordId || id.printing === "UNKNOWN" || !["HOLO", "REVERSE_HOLO", "NON_HOLO"].includes(id.finish)) return [];
    const card = await cardmarketRecord(String(id.recordId));
    if (!card || !sameCatalogName(card.name, id.name) || !sameSetFamily(card.setName, id.set) || !sameCardNumber(card.cardNumber, id.cardNumber)) return [];
    const variants = card.variants.filter(row => row.printing === id.printing && row.finish === id.finish);
    if (variants.length !== 1) return [];
    signal.throwIfAborted();
    const grader = value.slab?.grader ?? null, grade = value.slab?.grade ?? null;
    const variant = variants[0].name;
    // One recent PKMNPrices page, under the original account, using the same cache
    // and transaction/printing checks as inventory screening. No eBay Browse call.
    const { sales } = await createScreeningPriceSource({ signal }).fetchSoldPage(card.id, { variant, grader, grade });
    const matched = marketSummaries(sales, { record: card, printing: id.printing,
        finish: id.finish as "HOLO" | "REVERSE_HOLO" | "NON_HOLO", labels: [variant] }, grader, grade, now);
    return screeningSaleGroups(matched.filter(ref => grader || ref.condition === value.condition?.rawCondition), now);
}

const sources = { supplement: supplementalResearch, european: compareCardmarket, record: cardmarketRecord, rawQuote: tcgplayerRawPrice, recentSales };

export async function buyerMarketPrices(value: Evaluation, market: string, requestSignal: AbortSignal, deps = sources, now = Date.now) {
    const listing = { ...value.listing, images: value.listing.photos ?? [] };
    const prices = listingMarketPrices(value, listing, now());
    if (!prices?.lookup || prices.lookup.market !== market) return null;
    const stopped = new AbortController();
    const signal = AbortSignal.any([requestSignal, stopped.signal]);
    signal.throwIfAborted();
    const notes: string[] = [];
    async function optional<T>(source: string, lookup: () => Promise<T>) {
        signal.throwIfAborted();
        try { return await lookup(); }
        catch (error) {
            signal.throwIfAborted();
            if (storageFailure(error) || error instanceof PriceResearchBudgetError && error.reason !== "LIMIT") throw error;
            notes.push(source + " is unavailable for this check.");
            return null;
        }
    }
    // The evaluator normally already has TCGplayer. Older and thin evaluations can recover it
    // here without rerunning photos, underwriting, or eBay inventory discovery.
    const wear = value.condition?.rawCondition;
    async function missingTcg() {
        const id = value.identity;
        if ((prices?.tcg && (prices.tcg.validUntil ?? 0) > now()) || !id?.recordId || !isRawCondition(wear) || observedCardKind(value) !== "raw") return null;
        const card = await deps.record(String(id.recordId));
        signal.throwIfAborted();
        return card ? deps.rawQuote(mergeFamily([card]), id, wear, { signal, now: now() }) : null;
    }
    const tasks = withPriceResearchSignal(signal, () => [
        optional("Additional price sources", () => deps.supplement(value, { signal, now: now(), cacheOnly: false, comparePrices: true })),
        optional("Cardmarket", () => deps.european(value, { now, fx: async () => null })),
        optional("TCGplayer", missingTcg),
        !prices.sold && value.identity?.recordId ? optional("eBay sales", () => deps.recentSales(value, signal, now())) : null,
    ] as const);
    const [supplement, european, quote, saleGroups] = await Promise.all(tasks).catch(async error => {
        stopped.abort(error);
        await Promise.allSettled(tasks);
        throw error;
    });
    signal.throwIfAborted();
    if (supplement?.supplementalPriceNote) notes.push(supplement.supplementalPriceNote);
    const extra = providerPrices({ ...value, ...supplement }, now(), european ?? undefined);
    if (quote?.offers) {
        const snapshot = quote.offers, expiry = Date.parse(snapshot.checkedAt) + 6 * 3_600_000;
        if (snapshot.marketPrice) extra.push({ source: "TCGplayer", basis: snapshot.marketCondition + " market", price: snapshot.marketPrice,
            currency: "USD", asOf: snapshot.marketRecordAt || snapshot.checkedAt, validUntil: expiry });
        if (snapshot.offers.length) extra.push({ source: "TCGplayer", basis: snapshot.marketCondition + " lowest offer with shipping",
            price: Math.min(...snapshot.offers.map(row => row.total)), currency: "USD", asOf: snapshot.snapshotAt,
            validUntil: Math.min(expiry, Date.parse(snapshot.snapshotAt) + day) });
    }
    return { market, prices: extra, notes, ...(saleGroups?.length && { saleGroups }) };
}
