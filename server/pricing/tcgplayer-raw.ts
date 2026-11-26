import { CONDITION_NAMES, isRawCondition, type RawCondition } from '../../shared/conditions.ts';
import { sameCardNumber } from '../../shared/card-number.ts';
import { readyForPricing } from '../../shared/identity.ts';
import { money } from '../../shared/money/cents.ts';
import { median } from '../../shared/sold-evidence.ts';
import type { Identity, RawPrice, TcgplayerRawOffer } from '../../shared/types.ts';
import { sameNumberedCatalogName } from '../identity/catalog-name.ts';
import { finishOfVariant, mapVariantPrintings, sameSetFamily } from '../identity/card-identity.ts';
import { storageFailure } from '../lib/storage-failure.ts';
import { PriceResearchBudgetError } from './research-budget.ts';
import { fetchTcgplayerConditionData, fetchTcgplayerMarketData } from './pkmnprices.ts';
import { variantFor } from './raw-prices.ts';
import type { PricedCard } from './types.ts';

const DAY = 86_400_000;
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
interface Dependencies { offers: typeof fetchTcgplayerConditionData; market: typeof fetchTcgplayerMarketData }

/** Price an AI-assessed raw condition from that exact TCGplayer market. No sold-photo prerequisite. */
export async function tcgplayerRawPrice(card: PricedCard | null, identity: Identity, condition: RawCondition,
    { signal, now = Date.now(), cachedOnly = false, fetchOffers = fetchTcgplayerConditionData, fetchMarket = fetchTcgplayerMarketData }:
    { signal?: AbortSignal; now?: number; cachedOnly?: boolean; fetchOffers?: Dependencies['offers']; fetchMarket?: Dependencies['market'] } = {}): Promise<RawPrice | null> {
    signal?.throwIfAborted();
    if (!readyForPricing(identity) || !identity.name || !isRawCondition(condition) || !card) return null;
    const selected = variantFor(card, identity).variant;
    if (!selected || !sameSetFamily(selected.setName, identity.set) || !sameCardNumber(card.cardNumber, identity.cardNumber) ||
        !sameNumberedCatalogName(card.name, identity.name, selected.setName, card.cardNumber) ||
        identity.recordId != null && String(identity.recordId) !== String(selected.recordId)) return null;
    // TCGplayer has no separate Mint bucket. Use its Near Mint competition for
    // an observed Mint card rather than inventing a higher market.
    const marketCondition = condition === 'MINT' ? 'Near Mint' : CONDITION_NAMES[condition];
    const labelMatches = (label: string) => finishOfVariant(label) === identity.finish &&
        mapVariantPrintings([...card.variants.map(v => v.name), label], identity.set)[label] === identity.printing;
    let marketPrice: number | undefined, marketRecordAt: string | null = null;
    try {
        const detail = await fetchMarket(selected.recordId, cachedOnly);
        signal?.throwIfAborted();
        const body = detail?.data && !Array.isArray(detail.data) ? detail.data : detail;
        const number = body?.total_set_number ? `${body.number}/${body.total_set_number}` : body?.number;
        if (String(body?.id) === String(selected.recordId) && sameSetFamily(body?.set?.name, identity.set) && sameCardNumber(number, identity.cardNumber) &&
            sameNumberedCatalogName(body?.name, identity.name, body?.set?.name, number)) {
            const values = (Array.isArray(body.prices) ? body.prices : []).filter((row: any) =>
                row?.source === 'tcgplayer' && row.currency === 'USD' && key(text(row.condition)) === key(marketCondition) &&
                labelMatches(text(row.variant)) && positive(row.market_price));
            if (values.length === 1) { marketPrice = values[0].market_price; marketRecordAt = text(values[0].created_at) || null; }
        }
    } catch (error) { signal?.throwIfAborted(); if (storageFailure(error) || error instanceof PriceResearchBudgetError && error.reason !== 'LIMIT') throw error; }
    const offers: TcgplayerRawOffer[] = [];
    const ids = new Set<string>(), cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 4; page++) {
        let response;
        try { response = await fetchOffers(selected.recordId, marketCondition, selected.name, cursor, cachedOnly); }
        catch (error) { signal?.throwIfAborted(); if (storageFailure(error) || error instanceof PriceResearchBudgetError && error.reason !== 'LIMIT') throw error; break; }
        signal?.throwIfAborted();
        if (!Array.isArray(response?.data)) break;
        for (const row of response.data) {
            const id = String(row?.listing_id ?? row?.id ?? ''), sellerId = text(row?.seller_id) || text(row?.seller_name);
            const at = Date.parse(row?.snapshot_at ?? ''), age = now - at;
            if (!id || ids.has(id) || !sellerId || row.language !== 'English' || key(text(row.condition)) !== key(marketCondition) ||
                !labelMatches(text(row.printing)) || !positive(row.price) || typeof row.shipping_price !== 'number' ||
                !Number.isFinite(row.shipping_price) || row.shipping_price < 0 || !Number.isSafeInteger(row.quantity) || row.quantity < 1 ||
                !(age >= 0 && age < DAY) || /\b(?:signed|autograph|altered|proxy|replica|lot|bundle|misprint|miscut)\b/i.test(text(row.custom_title))) continue;
            ids.add(id);
            offers.push({ id, sellerId, sellerName: text(row.seller_name), price: row.price, shipping: row.shipping_price,
                total: money(row.price + row.shipping_price), quantity: row.quantity, snapshotAt: new Date(at).toISOString() });
        }
        // Sorted by delivered total: the first usable page already supplies
        // competition. Later pages recover filtered/stale/ambiguous rows only.
        if (offers.length || !response.pagination?.has_more) break;
        const next = text(response.pagination?.next_cursor);
        if (!next || cursors.has(next)) break;
        cursors.add(next); cursor = next;
    }
    const checkedAt = new Date(now).toISOString();
    if (!offers.length && marketPrice === undefined) return null;
    const sorted = offers.slice().sort((a,b) => a.total - b.total);
    const values = sorted.map(row => row.total);
    const price = money(sorted.length ? Math.min(sorted[0].total, marketPrice ?? Infinity) : marketPrice!);
    return { condition, price, updatedAt: checkedAt, basis: sorted.length ? 'TCGPLAYER_OFFERS' : 'TCGPLAYER_MARKET', offers: {
        source: 'TCGPLAYER', currency: 'USD', condition, marketCondition, printing: selected.name, checkedAt,
        snapshotAt: sorted.length ? sorted.map(row => row.snapshotAt).sort()[0] : checkedAt,
        method: sorted.length ? 'LOWEST_DELIVERED_COMPETITION' : 'CONDITION_MARKET',
        ...(marketPrice !== undefined && { marketPrice, marketRecordAt }), price,
        low: values[0] ?? price, median: values.length ? median(values) : price, high: values.at(-1) ?? price,
        sellerCount: new Set(sorted.map(row => row.sellerId)).size, offers: sorted,
    } };
}
