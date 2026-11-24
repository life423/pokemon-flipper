import '../fixtures/isolated-data.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { tcgplayerRawPrice } from '../../server/pricing/tcgplayer-raw.ts';
import { isRawSoldPrice, isUsableRawPrice, referencePriceReason } from '../../shared/money/price-evidence.ts';
import { underwrite } from '../../shared/money/underwriting.ts';
import { currentPriceEvidence, PRICING_VERSION } from '../../shared/pricing-freshness.ts';
import { cardEvaluation } from '../fixtures/card-evaluation.ts';
import type { Identity, RawPricing } from '../../shared/types.ts';
import type { PricedCard } from '../../server/pricing/types.ts';

const now = Date.parse('2026-11-24T18:00:00Z');
const snapshot = new Date(now - 3600_000).toISOString();
const identity = { ...cardEvaluation().identity!, name: 'Alakazam', set: 'Base Set', cardNumber: '1/102', printing: 'UNLIMITED', finish: 'HOLO' } as Identity;
const card: PricedCard = { source: 'pkmnprices', name: 'Alakazam', cardNumber: '1/102', records: [], variants: [
    { name: 'Unlimited Holofoil', printing: 'UNLIMITED', finish: 'HOLO', recordId: 123, setName: 'Base Set' },
] };
const detail = (prices: unknown[] = []) => ({ id: 123, name: 'Alakazam', number: '1', total_set_number: '102', set: { name: 'Base Set' }, prices });
const marketRow = { source: 'tcgplayer', currency: 'USD', condition: 'Lightly Played', variant: 'Unlimited Holofoil', market_price: 75, created_at: '2026-01-01' };
const offer = (id: number, price: number, extra = {}) => ({ listing_id: id, seller_id: String(id), seller_name: `Seller ${id}`,
    printing: 'Unlimited Holofoil', condition: 'Lightly Played', language: 'English', price, shipping_price: 2,
    quantity: 1, updated_at: '2020-01-01', snapshot_at: snapshot, ...extra });

test('AI condition selects exact TCGplayer delivered competition; a high asking outlier cannot set value', async () => {
    const calls: unknown[][] = [];
    const quote = await tcgplayerRawPrice(card, identity, 'LIGHTLY_PLAYED', { now,
        fetchMarket: async () => detail([marketRow]), fetchOffers: async (...args) => { calls.push(args); return { data: [offer(1, 60), offer(2, 65), offer(3, 1000)] }; } });
    assert.deepEqual(calls, [[123, 'Lightly Played', 'Unlimited Holofoil', undefined]]);
    assert.equal(quote?.price, 62);
    assert.equal(quote?.offers?.sellerCount, 3);
    assert.equal(quote?.offers?.marketPrice, 75);
    assert.ok(isUsableRawPrice(quote!));
    assert.equal(isRawSoldPrice(quote!), false, 'asking quotes never masquerade as completed sales');
});

test('fresh snapshot accepts unchanged offers; wrong condition, edition, currency-independent language, missing shipping and stale snapshots do not inflate price', async () => {
    const rows = [offer(1, 500, { condition: 'Near Mint' }), offer(2, 500, { printing: '1st Edition Holofoil' }),
        offer(3, 500, { language: 'Japanese' }), offer(4, 500, { shipping_price: null }), offer(5, 500, { snapshot_at: null }),
        offer(6, 500, { snapshot_at: new Date(now - 2 * 86400_000).toISOString() }), offer(7, 50)];
    const quote = await tcgplayerRawPrice(card, identity, 'LIGHTLY_PLAYED', { now, fetchMarket: async () => detail(), fetchOffers: async () => ({ data: rows }) });
    assert.equal(quote?.price, 52);
    assert.equal(quote?.offers?.offers.length, 1);
});

test('exact condition market can price a copy with no sold-photo comparison or active offer; other conditions cannot substitute', async () => {
    const quote = await tcgplayerRawPrice(card, identity, 'LIGHTLY_PLAYED', { now,
        fetchMarket: async () => detail([marketRow, { ...marketRow, condition: 'Near Mint', market_price: 900 }]), fetchOffers: async () => ({ data: [] }) });
    assert.equal(quote?.price, 75);
    assert.equal(quote?.basis, 'TCGPLAYER_MARKET');
    assert.ok(isUsableRawPrice(quote!));
    const missing = await tcgplayerRawPrice(card, identity, 'MODERATELY_PLAYED', { now, fetchMarket: async () => detail([marketRow]), fetchOffers: async () => ({ data: [] }) });
    assert.equal(missing, null);
});

test('Mint is conservatively valued against Near Mint and market quote caps isolated high competition', async () => {
    let condition = '';
    const quote = await tcgplayerRawPrice(card, identity, 'MINT', { now,
        fetchMarket: async () => detail([{ ...marketRow, condition: 'Near Mint', market_price: 100 }]),
        fetchOffers: async (_id, value) => { condition = value; return { data: [offer(1, 900, { condition: 'Near Mint' })] }; } });
    assert.equal(condition, 'Near Mint'); assert.equal(quote?.price, 100); assert.equal(quote?.condition, 'MINT');
});

test('supported TCGplayer estimate reaches raw profit calculation with zero eBay sold-photo prices', async () => {
    const price = (await tcgplayerRawPrice(card, identity, 'LIGHTLY_PLAYED', { now, fetchMarket: async () => detail([marketRow]), fetchOffers: async () => ({ data: [offer(1, 60)] }) }))!;
    const e = cardEvaluation({ minProfit: 0, minRoi: 0 });
    e.identity = identity; e.condition!.rawCondition = 'LIGHTLY_PLAYED'; e.condition!.authenticity.concern = 'NONE_SEEN';
    e.condition!.creases = 'NONE_SEEN'; e.listing.price = 20; e.listing.shipping = 0; e.listing.availability = 'ACTIVE';
    e.listing.buyingOption = 'FIXED_PRICE'; e.gradedPricing = null; e.slab = null;
    e.rawPricing = { status: 'PRICED', source: 'pkmnprices', printing: 'UNLIMITED', finish: 'HOLO', variant: 'Unlimited Holofoil', conditionEvidence: 'TCGPLAYER', prices: [price] } satisfies RawPricing;
    const u = underwrite(e); e.underwriting = u;
    assert.equal(u.verdict, 'BUY_RAW'); assert.ok(u.best!.profit > 0);
    assert.equal(referencePriceReason(e, u.best!), null);
    e.pricingVersion = PRICING_VERSION; e.pricesCheckedAt = new Date(now).toISOString();
    e.assessmentVersion = 'test/bounded-prompts-4'; e.conditionVersion = 'test/bounded-condition-1/prompts-1';
    assert.equal(currentPriceEvidence(e, now), true);
    assert.equal(currentPriceEvidence(e, now + 86400_000), false);
});

test('a returned product with wrong identity cannot supply a condition-market estimate', async () => {
    const quote = await tcgplayerRawPrice(card, identity, 'LIGHTLY_PLAYED', { now,
        fetchMarket: async () => ({ ...detail([marketRow]), number: '2' }), fetchOffers: async () => ({ data: [] }) });
    assert.equal(quote, null);
});
