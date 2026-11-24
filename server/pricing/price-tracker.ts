import type { Evaluation } from "../../shared/types.ts";
import { CONDITION_NAMES, RAW_CONDITIONS, isRawCondition } from "../../shared/conditions.ts";
import type { TrackerPriceReference, TrackerRawReference } from "../../shared/tracker-price-reference.ts";
import { readyForPricing } from "../../shared/identity.ts";
import { cardLanguageStatus } from "../../shared/card-language.ts";
import { observedCardKind, displayedRawGrade, obscuredDisclosedWear } from "../../shared/photo-evidence.ts";
import { verifiedSlabMarketKey } from "../../shared/slab-market.ts";
import { unsupportedVariantReason } from "../../shared/money/price-evidence.ts";
import { hasBaseSetFourthPrint } from "../../shared/reprint-release.ts";
import { getBudgetContext } from "../ai/usage-context.ts";
import { normalizeCardNumber, normalizeSetName, sameSetFamily, sameCardNumber } from "../identity/card-identity.ts";
import { requireLiveProvider } from "../lib/saved-provider-evidence.ts";
import { assertSqlStorageReady, StorageUnavailableError } from "../storage/index.ts";
import { reserveTrackerLookup } from "./tracker-allowance.ts";
import { cardVariants } from "./records.ts";
import { sameCatalogName, catalogPrintedName } from "../identity/catalog-name.ts";
import { cachedPricingRecord } from "./pkmnprices.ts";
import type { CardRecord } from "./types.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { setKey } from "../../shared/sets.ts";
import { fetchJson } from "../lib/http.ts";
import { createLimiter } from "../lib/concurrency.ts";
import { createSingleFlight } from "../lib/single-flight.ts";
const limit = createLimiter(2);
const share = createSingleFlight();

const BASE = "https://www.pokemonpricetracker.com/api/v2";

// A PokemonPriceTracker request, with a failure turned into a message.
async function trackerGet(path: string): Promise<{ data?: unknown; metadata?: { hasMore?: boolean } }> {
    const apiKey = process.env.POKEMON_PRICE_TRACKER_API_KEY;

    if (!apiKey) {
        throw new Error("POKEMON_PRICE_TRACKER_API_KEY is not set");
    }

    const { response, body } = await limit(async () => {
        requireLiveProvider("POKEMON_PRICE_TRACKER");
        await assertSqlStorageReady();
        return fetchJson(`${BASE}${path}`, {
            headers: { Authorization: `Bearer ${apiKey}` },
        }, { service: "PokemonPriceTracker" });
    });

    if (!response.ok) {
        throw new Error(
            `PokemonPriceTracker request failed (${response.status}): ${body.error ?? body.message ?? "unknown error"}`
        );
    }

    return body;
}

const YEARS_KEY = "pokemonpricetracker:set-years";
const MONTH_HOURS = 24 * 30;
const SETS_PAGE = 100;
const MOST_SET_PAGES = 20;

// Each English set's release year, by set key (shared/sets.ts), for every
// set PokemonPriceTracker knows. Saved for a month: sets don't change.
export async function setYears(): Promise<Record<string, number>> {
    return share(YEARS_KEY, async () => {
    const cached = await readCache<Record<string, number>>(YEARS_KEY, MONTH_HOURS);

    if (cached) return cached;

    const years: Record<string, number> = {};

    for (let page = 0; page < MOST_SET_PAGES; page += 1) {
        const body = await trackerGet(`/sets?limit=${SETS_PAGE}&offset=${page * SETS_PAGE}`);
        const sets = Array.isArray(body.data)
            ? (body.data as { name: string; releaseDate?: string | null; language?: string }[])
            : [];

        for (const set of sets) {
            if (set.language && !/english/i.test(set.language)) continue;

            const year = set.releaseDate ? new Date(set.releaseDate).getUTCFullYear() : Number.NaN;
            if (Number.isFinite(year)) years[setKey(set.name)] ??= year;
        }

        if (!body.metadata?.hasMore || sets.length === 0) break;
    }

    await writeCache(YEARS_KEY, years);
    return years;
    });
}

const trackerShares = createSingleFlight();
const standardVariant = /^(?:(?:1st edition|shadowless|unlimited) )?(?:normal|holo(?:foil)?|reverse holo(?:foil)?)$|^(?:1st edition|unlimited)$/i;
type GradeTarget = { grader: string; grade: string; estimated: boolean; cacheOnly?: boolean };

// A readable ungraded card in a protective holder can support a conditional
// example even when its exact play condition is unknown. Reuse paid data only.
export function provisionalTrackerGrade(value: Evaluation): number | null {
    const photo = value.photoCheck, condition = value.condition;
    if (!readyForPricing(value.identity) || value.identity?.notThisCard || condition?.rawCondition !== "UNKNOWN" ||
        condition.authenticity.concern !== "NONE_SEEN" || condition.creases !== "NONE_SEEN" || obscuredDisclosedWear(value) ||
        photo?.cardCount !== "ONE" || photo.cardMatch?.verdict !== "MATCH" || value.slab || photo.slab?.present ||
        observedCardKind(value) !== "raw" && !(photo.holder === "OTHER" && /^ungraded$/i.test(value.listing.sellerCondition ?? "")) ||
        !["FRONT", "BACK"].every(view => photo.images.some(image => image.view === view && image.usable && !image.isStockImage))) return null;
    const estimate = displayedRawGrade(value);
    if (estimate?.source !== "PROVISIONAL") return null;
    const { low, likely, high } = estimate.range;
    return likely != null && [low, likely, high].every(grade => Number.isInteger(grade) && grade >= 1 && grade <= 10) &&
        low <= likely && likely <= high && high - low <= 2 ? likely : null;
}
function gradeTarget(value: Evaluation): GradeTarget | null {
    const identity = value.identity;
    if (!identity?.name || !identity.set || !identity.cardNumber || !readyForPricing(identity) || identity.notThisCard ||
        !/^\d+$/.test(String(identity.recordId ?? "")) || !["HOLO", "NON_HOLO", "REVERSE_HOLO"].includes(identity.finish) ||
        cardLanguageStatus("", [identity.language, value.photoCheck?.cardIdentity?.language]) !== "ENGLISH" ||
        cardLanguageStatus(value.listing.title, [value.listing.aspects.Language]) === "OTHER" ||
        value.photoCheck?.cardMatch?.verdict === "MISMATCH" || unsupportedVariantReason(value) ||
        hasBaseSetFourthPrint(identity.set, value.listing.title)) return null;
    if (observedCardKind(value) === "graded" && verifiedSlabMarketKey(value, { allowScratchedCase: true })) {
        const { grader, grade } = value.slab!;
        return grader && grade && ["PSA", "CGC"].includes(grader) ? { grader, grade, estimated: false } : null;
    }
    if (value.condition?.rawCondition === "UNKNOWN") {
        const grade = provisionalTrackerGrade(value);
        return grade === null ? null : { grader: "PSA", grade: String(grade), estimated: true, cacheOnly: true };
    }
    if (observedCardKind(value) !== "raw" || value.slab || obscuredDisclosedWear(value) ||
        value.condition?.authenticity.concern !== "NONE_SEEN") return null;
    const grade = displayedRawGrade(value)?.range.likely;
    return typeof grade === "number" && Number.isInteger(grade) && grade >= 1 && grade <= 10 ?
        { grader: "PSA", grade: String(grade), estimated: true } : null;
}

function object(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const usd = (row: Record<string, unknown>) => row.currency === undefined || row.currency === "USD";
function freshDate(input: unknown, maxDays: number, now: number): string | null {
    const time = typeof input === "string" ? Date.parse(input) : NaN;
    const age = now - time;
    return age >= 0 && age <= maxDays * 86_400_000 ? new Date(time).toISOString() : null;
}

function exactProduct(card: CardRecord, value: Evaluation): boolean {
    const identity = value.identity!;
    return !!card.tcgPlayerId && Number.isSafeInteger(card.tcgPlayerId) && card.tcgPlayerId > 0 &&
        String(card.id) === String(identity.recordId) && !!card.setName && sameCatalogName(card.name, identity.name) &&
        sameSetFamily(card.setName, identity.set) && sameCardNumber(card.cardNumber, identity.cardNumber) &&
        card.variants.filter(variant => variant.printing === identity.printing && variant.finish === identity.finish && standardVariant.test(variant.name)).length === 1;
}

// TCGplayer distinguishes the holo Dark Alakazam (1) from the non-holo (18).
// Resolve a numeric suffix only if it repeats the independent collector number.
function trackerPrintedName(name: string, set: string, number: string) {
    const numbered = /^(.+) \((\d{1,4})\)$/.exec(name.trim());
    if (numbered && sameCardNumber(numbered[2], number)) return numbered[1]!;
    return catalogPrintedName(name, set, number);
}

function matchedProduct(body: unknown, value: Evaluation, card: CardRecord) {
    const response = object(body);
    const metadata = object(response.metadata);
    const rows = response.data;
    if (Array.isArray(rows) && rows.length !== 1) return null;
    const row = object(Array.isArray(rows) ? rows[0] : rows);
    const market = object(row.ebay);
    if (String(row.tcgPlayerId) !== String(card.tcgPlayerId) || typeof row.name !== "string" || typeof row.setName !== "string" ||
        !sameCatalogName(trackerPrintedName(row.name, row.setName, String(row.cardNumber)), card.name) || normalizeSetName(row.setName) !== normalizeSetName(card.setName) ||
        !sameCardNumber(row.cardNumber, card.cardNumber) || row.totalSetNumber != null &&
        normalizeCardNumber(card.cardNumber)?.total != null && !sameCardNumber(row.totalSetNumber, card.cardNumber.split("/")[1]) ||
        [row.language, metadata.language].some(language => language != null &&
            (typeof language !== "string" || cardLanguageStatus("", [language]) !== "ENGLISH")) ||
        ![response, metadata, row, market].every(usd)) return null;

    const printings = row.printingsAvailable;
    if (!Array.isArray(printings) || !printings.every(label => typeof label === "string")) return null;
    const matches = cardVariants(printings, row.setName).filter(variant => standardVariant.test(variant.name) &&
        variant.printing === value.identity!.printing && variant.finish === value.identity!.finish);
    if (matches.length !== 1) return null;
    const label = matches[0]!.name;
    return { row, label, market };
}

function gradeReference(product: NonNullable<ReturnType<typeof matchedProduct>>, card: CardRecord, target: GradeTarget, now: number): TrackerPriceReference | null {
    const { label, market } = product;
    const perPrinting = object(market.salesByPrinting);
    const printingBucket = object(perPrinting[label]);
    // A primary-product summary is only safe for legacy, single-printing products.
    const scoped = Object.hasOwn(perPrinting, label);
    if (!scoped && (card.variants.length !== 1 || (product.row.printingsAvailable as string[]).length !== 1 || Object.keys(perPrinting).length)) return null;
    const gradeKey = target.grader.toLowerCase() + target.grade.replace(".", "_");
    const bucket = object(object((scoped ? printingBucket : market).salesByGrade)[gradeKey]);
    if (!usd(printingBucket) || !usd(bucket)) return null;
    const reportedSales = bucket.count;
    const lastSaleAt = freshDate(bucket.lastSaleDate, 90, now);
    if (typeof reportedSales !== "number" || !Number.isSafeInteger(reportedSales) || reportedSales < 1 || !lastSaleAt) return null;
    const weekly = freshDate(bucket.lastMarketUpdate, 2, now) && freshDate(lastSaleAt, 7, now) ? bucket.marketPriceMedian7Day : null;
    const priceUsd = positive(weekly) ? weekly : bucket.medianPrice;
    if (!positive(priceUsd)) return null;
    const sources = object(bucket.salesBySource);
    const marketplaces = Object.entries(sources).filter(([, count]) => typeof count === "number" && Number.isSafeInteger(count) && count > 0)
        .map(([name]) => name === "ebay" ? "eBay" : name === "fanatics" ? "Fanatics Collect" : "Other");
    const filtered = object(bucket.smartMarketPrice);
    const days = filtered.daysUsed, confidence = filtered.confidence;
    const timedEstimate = scoped && positive(days) && Number.isInteger(days) && days <= 90 && filtered.method === days + "day_filtered_weighted" &&
        (confidence === "low" || confidence === "medium" || confidence === "high") && positive(filtered.price) &&
        freshDate(lastSaleAt, days, now) && freshDate(bucket.lastMarketUpdate, 2, now)
        ? { priceUsd: filtered.price, days, confidence } : undefined;
    return { source: "POKEMON_PRICE_TRACKER", tcgPlayerId: card.tcgPlayerId!, printingLabel: label,
        gradedMarket: { grader: target.grader, grade: target.grade, priceUsd, statistic: positive(weekly) ? "7_DAY_MEDIAN" : "HISTORICAL_MEDIAN",
            reportedSales, lastSaleAt, marketplaces: [...new Set(marketplaces)], ...(timedEstimate && { filteredEstimate: timedEstimate }) },
        caveat: (target.estimated ? "This price applies if the raw card receives the estimated grade. " : "") +
            (scoped ? "The provider groups sales by printing, grader and grade. " : "Both catalogs report one printing. The provider groups sales by product and grade. ") +
            "The count covers its reported history. Individual prices, slab condition and sale formats require separate evidence." };
}

interface TrackerOptions { cacheOnly?: boolean }
async function trackerProduct(value: Evaluation, signal: AbortSignal | undefined, cacheOnly: boolean) {
    signal?.throwIfAborted();
    const card = await cachedPricingRecord(String(value.identity!.recordId));
    if (!card || !exactProduct(card, value)) return null;
    const id = card.tcgPlayerId!;
    const key = `pokemonpricetracker:card-by-tcg:v2:${id}:ebay:limit1`;
    let body = await readCache<unknown>(key, 24);
    signal?.throwIfAborted();
    if (body === null) {
        const apiKey = process.env.POKEMON_PRICE_TRACKER_API_KEY?.trim();
        const searchId = getBudgetContext().searchId;
        if (cacheOnly || !apiKey || !searchId) return null;
        requireLiveProvider("POKEMON_PRICE_TRACKER");
        body = await trackerShares(key, () => limit(async () => {
            signal?.throwIfAborted();
            const saved = await readCache<unknown>(key, 24);
            if (saved !== null) return saved;
            await assertSqlStorageReady();
            signal?.throwIfAborted();
            if (!await reserveTrackerLookup(apiKey, searchId, id, new Date())) return null;
            signal?.throwIfAborted();
            const url = `${BASE}/cards?tcgPlayerId=${id}&includeEbay=true&limit=1`;
            const answer = await fetchJson(url, { headers: { Authorization: `Bearer ${apiKey}` } }, { service: "Pokémon Price Tracker" })
                .catch(() => null);
            if (!answer) return null;
            const consumed = answer.response.headers.get("x-api-calls-consumed");
            // Keep the account's reported credit count separate from the fixed
            // reservation. Failed HTTP outcomes also retain the original slot.
            await writeCache(`${key}:receipt:${searchId}`, { status: answer.response.status, reservedCredits: 2,
                reportedCredits: consumed !== null && /^\d+$/.test(consumed) ? Number(consumed) : null });
            if (!answer.response.ok || !answer.body || !Object.hasOwn(answer.body, "data")) return null;
            await writeCache(key, answer.body);
            return answer.body;
        }));
    }
    signal?.throwIfAborted();
    if (body === null) return null;
    if (!Object.hasOwn(object(body), "data")) throw new StorageUnavailableError("Saved Pokémon Price Tracker evidence is invalid.");
    const product = matchedProduct(body, value, card);
    return product && { card, product };
}

function rawTarget(value: Evaluation) {
    const identity = value.identity, condition = value.condition?.rawCondition;
    if (!readyForPricing(identity) || !identity?.recordId || identity.printing === "UNKNOWN" || identity.notThisCard || !isRawCondition(condition) ||
        value.slab || observedCardKind(value) !== "raw" || value.photoCheck?.cardMatch?.verdict !== "MATCH" ||
        value.condition?.authenticity.concern !== "NONE_SEEN" || unsupportedVariantReason(value) || obscuredDisclosedWear(value) ||
        cardLanguageStatus(value.listing.title, [identity.language, value.listing.aspects.Language]) !== "ENGLISH" ||
        hasBaseSetFourthPrint(identity.set, value.listing.title)) return null;
    return { recordId: String(identity.recordId), printing: identity.printing, finish: identity.finish, condition };
}

// TCGplayer's primary market price can describe a different printing or wear level.
// Keep only the named entry for this printing, preferring the assessed condition.
function rawReference(result: NonNullable<Awaited<ReturnType<typeof trackerProduct>>>, target: NonNullable<ReturnType<typeof rawTarget>>): TrackerRawReference | null {
    const { row, label } = result.product;
    const prices = object(row.prices);
    const conditions = object(object(prices.variants)[label]);
    if (!usd(prices) || !usd(conditions)) return null;
    // A cleaner-condition quote is useful context when the exact market is absent.
    for (const wear of [...RAW_CONDITIONS.slice(0, RAW_CONDITIONS.indexOf(target.condition) + 1)].reverse()) {
        const point = object(conditions[CONDITION_NAMES[wear] + " " + label]);
        const updatedAt = freshDate(point.lastUpdated, 7, Date.now());
        if (positive(point.price) && usd(point) && updatedAt) return { source: "TCGPLAYER_MARKET", tcgPlayerId: result.card.tcgPlayerId!,
            recordId: target.recordId, printing: target.printing, finish: target.finish,
            condition: wear, priceUsd: point.price, updatedAt };
    }
    return null;
}

export async function trackerMarketReferences(value: Evaluation, signal?: AbortSignal, { cacheOnly = false }: TrackerOptions = {}): Promise<Pick<Evaluation, "trackerPriceReference" | "trackerRawReference"> | null> {
    const grade = gradeTarget(value), raw = rawTarget(value);
    if (!grade && !raw) return null;
    const result = await trackerProduct(value, signal, cacheOnly || grade?.cacheOnly === true);
    if (!result) return null;
    const graded = grade && gradeReference(result.product, result.card, grade, Date.now());
    const ungraded = raw && rawReference(result, raw);
    return { ...(graded && { trackerPriceReference: graded }), ...(ungraded && { trackerRawReference: ungraded }) };
}

export async function trackerPriceReference(value: Evaluation, signal?: AbortSignal, options: TrackerOptions = {}): Promise<TrackerPriceReference | null> {
    if (!gradeTarget(value)) return null;
    return (await trackerMarketReferences(value, signal, options))?.trackerPriceReference ?? null;
}
