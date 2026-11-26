import { createHash } from "node:crypto";
import { parseListingLink } from "../../shared/listing-link.ts";
import { cardLanguageStatus } from "../../shared/card-language.ts";
import { median } from "../../shared/sold-evidence.ts";
import { verifiedSlabMarketKey } from "../../shared/slab-market.ts";
import type { ProviderPrice, BuyerPriceComparison } from "../../shared/listing-market-prices.ts";
import type { Evaluation } from "../../shared/types.ts";
import type { DailyPrice } from "../../shared/price-history.ts";
import { matchesStandardCatalogProduct } from "./price-tracker.ts";
import type { TradedCard } from "./traded-cards.ts";
import { requireLiveProvider } from "../lib/saved-provider-evidence.ts";
import { createSharedWork } from "../lib/shared-work.ts";
import { readMarketData, saveMarketData } from "./market-cache.ts";
import { pricingRecord } from "./pkmnprices.ts";
import { supplementalMarket } from "./supplemental-research.ts";
import type { CardRecord } from "./types.ts";

type SoldCitation = NonNullable<BuyerPriceComparison["silphHistory"]>["sales"][number];

const day = 86_400_000;
const share = createSharedWork();
const base = "https://silphcoanalytics.xyz/api/v3/";
const finishes = { NON_HOLO: "normal", HOLO: "holo", REVERSE_HOLO: "reverse_holo" } as const;
type Cohort = { product: string; grade_key: string; edition: string; finish: string };
type Json = Record<string, unknown>;
const object = (v: unknown): Json => v && typeof v === "object" && !Array.isArray(v) ? v as Json : {};
const positive = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;
const text = (v: unknown) => typeof v === "string" ? v : "";
function time(v: unknown) {
    const stamp = text(v);
    return Date.parse(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?$/.test(stamp) ? stamp + "Z" : stamp);
}

export function silphCohort(e: Evaluation, record: CardRecord): Cohort | null {
    const target = supplementalMarket(e, true), id = e.identity;
    if (!target || target.provisional !== null || !id?.recordId || !matchesStandardCatalogProduct(record, e) ||
        record.variants.filter(v => v.printing === id.printing && v.finish === id.finish).length !== 1 ||
        id.printing === "UNKNOWN" || !(id.finish in finishes)) return null;
    const { grader, grade } = target.market;
    const wear = e.condition?.rawCondition;
    if (grader === "RAW" ? !wear || wear === "MINT" || wear === "UNKNOWN" : !verifiedSlabMarketKey(e, { allowScratchedCase: true })) return null;
    return { product: String(record.tcgPlayerId), grade_key: grader === "RAW" ? "raw:" + wear!.toLowerCase() : grader + ":" + grade,
        edition: id.printing.toLowerCase(), finish: finishes[id.finish as keyof typeof finishes] };
}

async function request(path: string, params: Record<string,string>, signal: AbortSignal) {
    const secret = process.env.SILPHCO_API_KEY?.trim();
    if (!secret) return null;
    const url = new URL(path, base);
    url.search = new URLSearchParams(params).toString();
    const account = createHash("sha256").update(secret).digest("hex").slice(0,24);
    const key = "silph-v1:" + account + ":" + createHash("sha256").update(url.href).digest("hex");
    const hours = params.agg === "movers" ? 24 : path === "listings" ? 0.5 : 6;
    return share(key, async active => {
        const cached = await readMarketData(key, hours);
        if (cached !== null && cached !== undefined) return cached;
        const pauseKey = "silph-backoff:" + account;
        const pause = await readMarketData(pauseKey, 24);
        if (typeof pause === "number" && pause > Date.now()) return null;
        active.throwIfAborted();
        requireLiveProvider("SILPHCO");
        const stop = AbortSignal.any([active, AbortSignal.timeout(params.agg === "movers" ? 25_000 : 12_000)]);
        let body: unknown;
        try {
            const response = await fetch(url, { headers: { Authorization: "Bearer " + secret, Accept: "application/json" }, redirect: "error", signal: stop });
            if (response.status === 429) {
                const retry = response.headers.get("retry-after");
                const until = retry && /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry ?? "");
                await saveMarketData(pauseKey, Number.isFinite(until) && until > Date.now() ? until : Date.now() + 60_000);
            }
            if (!response.ok) {
                await response.body?.cancel();
                if (response.status === 401 || response.status === 403) await saveMarketData(pauseKey, Date.now() + 5 * 60_000);
                if (response.status === 404 || response.status === 400) await saveMarketData(key, { unavailable: true });
                return null;
            }
            body = await response.json();
        } catch (error) {
            active.throwIfAborted();
            if (!(error instanceof TypeError || error instanceof SyntaxError || stop.aborted)) throw error;
            return null;
        }
        if (!object(body).data) return null;
        await saveMarketData(key, body);
        return body;
    }, signal);
}

const source = "Silph Co · eBay";
function sameMarket(row: Json, c: Cohort, sku: string) {
    return row.tcg_card_id === sku && row.grade_key === c.grade_key && row.finish === c.finish && row.edition === c.edition &&
        row.language === "en" && row.stamp == null;
}

export async function silphEvidence(c: Cohort, listingId: string, now: number, signal: AbortSignal, fetchData = request) {
    const prices: ProviderPrice[] = [], sales: SoldCitation[] = [], notes: string[] = [], points: DailyPrice[] = [], context: string[] = [];
    const { product, ...scope } = c;
    const filters = { ...scope, language: "en", marketplace: "ebay" };
    const response = object(await fetchData("price", { q: product, ...filters, method: "median_30d", outliers: "exclude" }, signal));
    const data = object(response.data), cohort = object(data.cohort), sku = text(cohort.tcg_card_id);
    if (response.contract !== "price.v2" || object(response.request).resolved_from !== product || !/^[\w-]{1,100}$/.test(sku) ||
        cohort.resolved_by !== "explicit" || !sameMarket(cohort, c, sku)) {
        notes.push("Silph Co could not confirm this exact market.");
        return { prices, sales, points, notes, context };
    }
    const status = data.status, basis = c.grade_key.replace("raw:", "").replaceAll("_"," ").replace(":", " ");
    const latest = time(data.newest_sale_at), age = now - latest, asOf = time(data.as_of);
    if (data.method === "median_30d" && data.outliers === "exclude" && data.served_stale === false && status === "ok" &&
        positive(data.value_usd) && positive(data.n_sales) && Number.isInteger(data.n_sales) && age >= 0 && age <= 30 * day &&
        asOf <= now && now - asOf < 2 * day) {
        prices.push({ source, basis: basis + " · 30-day sold median · " + data.n_sales + " provider-reported sales" +
            (object(data.quality).tier === "review" ? " · provider flagged for review" : ""),
            currency: "USD", price: data.value_usd, asOf: text(data.as_of), validUntil: Math.min(asOf + 2 * day, latest + 30 * day) });
    } else context.push("Silph Co returned no current 30-day median for " + basis + " (" +
        (["thin","stale","suspect","none"].includes(text(status)) ? status : "insufficient evidence") + ").");
    signal.throwIfAborted();
    const [tape, book] = await Promise.all([
        fetchData("sales", { ids: sku, ...filters, since: new Date(now - 60 * day).toISOString().slice(0,10), limit: "100", sort: "-date" }, signal),
        fetchData("listings", { ids: sku, ...scope, marketplace: "ebay" }, signal),
    ]);
    if (object(tape).contract !== "sales.v2") notes.push("Silph Co sale history is unavailable for this check.");
    const own = parseListingLink(listingId)?.itemId.split("|")[1], candidates = new Map<string, SoldCitation>();
    const conflicts = new Set<string>();
    const tapeData = object(object(tape).data);
    if (tapeData.next_cursor) context.push("Linked history shows eligible matches from the newest 100 sale records. The provider calculates its 30-day median separately.");
    const rows = tapeData.rows;
    for (const input of Array.isArray(rows) ? rows : []) {
        const row = object(input), at = time(row.sold_at), link = parseListingLink(row.url);
        if (!link || !link.itemId.endsWith("|0") || link.itemId.split("|")[1] === own || !sameMarket(row, c, sku) || row.marketplace !== "ebay" ||
            row.include_in_oracle !== true || row.excluded !== false || row.is_outlier !== false || row.grade_verified === false ||
            !positive(row.price_usd) || !(at <= now && now - at <= 60 * day)) continue;
        const sale = { url: link.url, priceUsd: row.price_usd, date: new Date(at).toISOString().slice(0,10) };
        const previous = candidates.get(link.itemId);
        if (previous && (previous.priceUsd !== sale.priceUsd || previous.date !== sale.date)) conflicts.add(link.itemId);
        candidates.set(link.itemId, sale);
    }
    const daily = new Map<string,number[]>();
    for (const [id, sale] of candidates) {
        if (conflicts.has(id)) continue;
        sales.push(sale);
        const values = daily.get(sale.date!) ?? [];
        values.push(sale.priceUsd);
        daily.set(sale.date!, values);
    }
    for (const date of [...daily.keys()].sort()) points.push({ day: date, price: median(daily.get(date)!) });
    // This endpoint pins edition in its echoed filter. It omits edition on individual offers.
    const axes = object(object(object(book).meta).cohort);
    const pinned = Object.entries({ grades: scope.grade_key, finish: scope.finish, edition: scope.edition }).every(([axis, wanted]) => {
        const got = object(axes[axis]);
        return got.resolved_by === "explicit" && Array.isArray(got.value) && got.value.length === 1 && got.value[0] === wanted;
    });
    let lowestDelivered: ProviderPrice | undefined, lowestItem: ProviderPrice | undefined;
    const offers = object(object(object(object(book).data).cards)[sku]).listings;
    if (object(book).contract !== "listings-collection.v1" || !pinned) notes.push("Silph Co could not confirm matching active asks.");
    else for (const input of Array.isArray(offers) ? offers : []) {
        const row = object(input), link = parseListingLink(row.url), at = time(row.last_verified_live_at), end = time(row.listing_end_at);
        if (row.marketplace !== "ebay" || row.currency !== "USD" || row.tcg_card_id !== sku || row.grade_key !== c.grade_key ||
            row.finish !== scope.finish || row.edition != null && row.edition !== scope.edition || row.stamp != null ||
            row.grade_disagrees === true || row.id_confidence_tier !== "high" || !link || link.itemId.split("|")[1] === own ||
            row.listing_status !== "live" || row.listing_format !== "fixed_price" || !(at <= now && now - at < 2 * day) ||
            row.ended_at || row.listing_end_at && !(end > now) || !positive(row.ask_price_usd) ||
            cardLanguageStatus(text(row.title), [text(row.language)]) === "OTHER") continue;
        const delivered = positive(row.landed_price_usd) && row.landed_price_usd >= row.ask_price_usd;
        const quote: ProviderPrice = { source, basis: basis + (delivered ? " · observed Buy It Now with shipping" : " · observed Buy It Now before shipping"),
            price: delivered ? Number(row.landed_price_usd) : row.ask_price_usd, currency: "USD", url: link.url,
            asOf: new Date(at).toISOString(), validUntil: Math.min(at + 2 * day, Number.isFinite(end) ? end : Infinity) };
        if (delivered && (!lowestDelivered || quote.price < lowestDelivered.price)) lowestDelivered = quote;
        if (!delivered && (!lowestItem || quote.price < lowestItem.price)) lowestItem = quote;
    }
    if (lowestDelivered) prices.push(lowestDelivered);
    if (lowestItem) prices.push(lowestItem);
    return { prices, sales, points, notes, context };
}

export async function silphComparison(value: Evaluation, signal?: AbortSignal, now = Date.now()) {
    if (!process.env.SILPHCO_API_KEY?.trim() || !value.identity?.recordId || !supplementalMarket(value, true)) return null;
    signal?.throwIfAborted();
    // Silph normalizes raw:mint to raw:near_mint. Preserve the assessed condition.
    if (value.condition?.rawCondition === "MINT" && !value.slab) return { prices: [], sales: [], points: [], notes: [],
        context: ["Silph Co groups Mint with Near Mint and has no separate Mint estimate."] };
    const record = await pricingRecord(String(value.identity.recordId));
    const market = record && silphCohort(value, record);
    return market ? silphEvidence(market, value.listing.id, now, signal ?? new AbortController().signal) : null;
}

// The set board pools conditions and editions. It supplies search leads only.
export async function silphSetSeeds(setId: string, name: string, signal: AbortSignal, fetchData = request): Promise<TradedCard[]> {
    if (!/^[a-z0-9.]{1,24}$/i.test(setId)) return [];
    const response = object(await fetchData("sales", { set_id: setId, agg: "movers", language: "en", marketplace: "ebay" }, signal));
    const rows = object(response.data).rows;
    if (response.contract !== "sales.v2" || object(response.request).set_id !== setId || !Array.isArray(rows) || rows.length !== 1) return [];
    const board = object(rows[0]);
    const hints = new Map<string, { card: TradedCard; activity: number }>();
    for (const group of [board.top_volume, board.top_gainers]) {
        for (const item of Array.isArray(group) ? group : []) {
            const row = object(item), sku = text(row.tcg_card_id), number = sku.slice(setId.length + 1);
            if (!sku.startsWith(setId + "-") || !/^[a-z]*[0-9]+[a-z]*$/i.test(number) || !text(row.name).trim() ||
                row.trust !== "ok" || row.capped !== false || !positive(row.n_sales) || !positive(row.n_sales_prior_7d)) continue;
            hints.set(sku, { card: { name: text(row.name), number, set: name, mover: "Silph Co set activity" },
                activity: Math.min(row.n_sales, row.n_sales_prior_7d) });
        }
    }
    return [...hints.values()].sort((a,b) => b.activity - a.activity).map(row => row.card);
}
