import '../fixtures/isolated-data.ts';
import { currentPriceEvidence } from '../../shared/pricing-freshness.ts';
import { listingMarketPrices } from '../../shared/listing-market-prices.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoundedEvaluator, type BoundedReading } from '../../server/analysis/bounded-evaluate.ts';
import { cardEvaluation, clearReleaseFixture } from '../fixtures/card-evaluation.ts';
import { tcgplayerRawPrice } from '../../server/pricing/tcgplayer-raw.ts';
import type { ListingDetails } from '../../server/ebay/listings.ts';
import type { CardRecord, PricedCard } from '../../server/pricing/types.ts';

const now = Date.parse('2026-11-24T18:00:00Z');
const photos = [1,2,3,4].map(n => `https://i.ebayimg.com/images/g/tcg-alakazam-${n}/s-l1600.jpg`);
const identity = { ...cardEvaluation().identity!, name: 'Alakazam', set: 'Base Set', cardNumber: '1/102', finish: 'HOLO', printing: 'UNLIMITED' } as const;
const record: CardRecord = { source: 'pkmnprices', id: 123, name: 'Alakazam', setName: 'Base Set', cardNumber: '1/102',
    variants: [{ name: 'Unlimited Holofoil', printing: 'UNLIMITED', finish: 'HOLO' }] };
const card: PricedCard = { source: 'pkmnprices', name: record.name, cardNumber: record.cardNumber, records: [record],
    variants: record.variants.map(v => ({ ...v, recordId: record.id, setName: record.setName })) };

function listingFixture() {
    const listing: ListingDetails = { id: 'v1|123456789012|0', title: 'Alakazam Base Set 1/102 Unlimited Holo',
        url: 'https://www.ebay.com/itm/123456789012', price: 20, shipping: 0, buyingOption: 'FIXED_PRICE', bestOffer: false,
        bids: 0, endTime: null, images: photos, seller: null, availability: 'ACTIVE', condition: 'Ungraded',
        cardCondition: 'Lightly Played', conditionNotes: [], aspects: { 'Card Name': 'Alakazam', Set: 'Base Set', 'Card Number': '1/102', Language: 'English', Finish: 'Holo' }, retrievedAt: new Date(now).toISOString() };
    const condition = structuredClone(cardEvaluation().condition!); condition.rawCondition = 'LIGHTLY_PLAYED'; condition.gradeRange = null;
    condition.authenticity = { concern: 'NONE_SEEN', reasons: [], limitations: [], observations: [] };
    const reading: BoundedReading = { condition, photoCheck: { cardCount: 'ONE', holder: 'NONE', photoSufficiency: 'SUFFICIENT', confidence: 'HIGH',
        printedName: 'Alakazam', printedNumber: '1/102', cardIdentity: { name: 'Alakazam', set: 'Base Set', cardNumber: '1/102', language: 'English', finish: 'HOLO', confidence: 'HIGH', evidence: ['Name, number and artwork identify the card.'] },
        images: photos.map((_,i) => ({ number: i+1, view: ['FRONT','BACK','FRONT_DETAIL','BACK_DETAIL'][i], usable: true, isStockImage: false, issues: [], obscuresCondition: false })),
        printingMarks: { firstEditionStamp: 'NOT_PRESENT', artBoxShadow: 'PRESENT', reprintMark: 'NONE_SEEN', evidence: ['Edition marks visible.'] },
        cardMatch: { verdict: 'MATCH', problems: [] }, missingViews: [], problems: [], slab: null } };
    return { listing, reading };
}

for (const scenario of ["confirmed competition", "lower verified eBay sale", "higher verified eBay sale", "single seller", "no condition quote"] as const)
test("bounded raw resale pricing with " + scenario, async () => {
    let acquisitions = 0, tcgCalls = 0;
    const saved = new Map<string, any>();
    const { listing, reading } = listingFixture();
    const quote = await tcgplayerRawPrice(card, identity, 'LIGHTLY_PLAYED', { now,
        fetchMarket: async () => ({ id: 123, name: 'Alakazam', number: '1', total_set_number: '102', set: { name: 'Base Set' }, prices: [] }),
        fetchOffers: async () => ({ data: (scenario === 'single seller' ? ['one'] : scenario === 'no condition quote' ? [] : ['one', 'two']).map((seller, i) => ({ listing_id: i+1, seller_id: seller, seller_name: seller, price: 70+i, shipping_price: 0, quantity: 1,
            condition: 'Lightly Played', printing: 'Unlimited Holofoil', language: 'English', snapshot_at: new Date(now).toISOString() })) }) });
    const sale = { id: "sold", title: "Alakazam 1/102 Base Set Unlimited Holo LP English", price: scenario === "higher verified eBay sale" ? 90 : 60,
        sold_at: new Date(now - 86400000).toISOString(), variant: "Unlimited Holofoil", currency: "USD", attribution: "exact" as const,
        sale_type: "fixed_price" as const, listing_url: "https://www.ebay.com/itm/223456789012", grader: null, grade: null, grade_qualifier: null };
    const evidence = { condition: "LIGHTLY_PLAYED", evidence: ["Wear visible in the sold front and back."], photoCount: 2 } as const;
    const evaluate = createBoundedEvaluator({ release: async e => clearReleaseFixture(e), now: () => now, details: async () => listing, saved: async () => null,
        cached: async key => saved.get(key) ?? null, save: async (key,value) => { saved.set(key, structuredClone(value)); }, assertPriceAvailable: async () => {},
        assess: async (_listing,selected) => ({ result: { ...reading, photoCheck: { ...reading.photoCheck, images: selected.map((photo,i) => ({ ...reading.photoCheck.images[photos.indexOf(photo.url)], number: i+1 })) } }, usage: { inputTokens: 1, outputTokens: 1 } }), identify: async () => ({ identity: structuredClone(identity), card }),
        lookup: async () => [record], fetchRawComps: async () => scenario === "confirmed competition" ? [] : [sale], fetchComps: async () => [], fetchCachedComps: async () => [], compChecks: async () => new Map(),
        soldCondition: _options => ({ read: async () => scenario === "lower verified eBay sale" ? evidence : null, status: () => 'UNREVIEWED', usage: [], acquire: async () => { acquisitions++; return evidence; } }) as any,
        tcgplayer: async (_card,_identity,wear) => { tcgCalls++; assert.equal(wear,'LIGHTLY_PLAYED'); return quote; } });
    const e = await evaluate(listing.id, { targets: { minProfit: 0, minRoi: 0 } });
    assert.ok(tcgCalls > 0);
    assert.equal(acquisitions, scenario === "single seller" || scenario === "no condition quote" || scenario === "higher verified eBay sale" ? 1 : 0);
    const usesTcg = scenario === "confirmed competition";
    assert.equal(e.rawPricing?.conditionEvidence, 'AI_PHOTOS');
    assert.equal(e.rawPricing?.prices?.[0]?.price, usesTcg ? undefined : sale.price);
    assert.equal(e.rawPricing?.tcgplayerReference?.price, scenario === "no condition quote" ? undefined : 70);
    assert.equal(e.underwriting?.verdict, usesTcg ? 'CANT_PRICE' : 'BUY_RAW');
});

async function evaluateWithQuote(soldPrices: number[] = [], observedWear: 'LIGHTLY_PLAYED' | 'MODERATELY_PLAYED' | 'MIXED' | null = 'LIGHTLY_PLAYED', acquireWear = false) {
    let acquisitions = 0, tcgCalls = 0;
    const saved = new Map<string, any>();
    const { listing, reading } = listingFixture();
    const quote = await tcgplayerRawPrice(card, identity, 'LIGHTLY_PLAYED', { now,
        fetchMarket: async () => ({ id: 123, name: 'Alakazam', number: '1', total_set_number: '102', set: { name: 'Base Set' }, prices: [] }),
        fetchOffers: async () => ({ data: [{ listing_id: 1, seller_id: 'one', seller_name: 'One', price: 70, shipping_price: 0, quantity: 1,
            condition: 'Lightly Played', printing: 'Unlimited Holofoil', language: 'English', snapshot_at: new Date(now).toISOString() }] }) });
    const evaluate = createBoundedEvaluator({ release: async e => clearReleaseFixture(e), now: () => now, details: async () => listing, saved: async () => null,
        cached: async key => saved.get(key) ?? null, save: async (key,value) => { saved.set(key, structuredClone(value)); }, assertPriceAvailable: async () => {},
        assess: async (_listing,selected) => ({ result: { ...reading, photoCheck: { ...reading.photoCheck, images: selected.map((photo,i) => ({ ...reading.photoCheck.images[photos.indexOf(photo.url)], number: i+1 })) } }, usage: { inputTokens: 1, outputTokens: 1 } }), identify: async () => ({ identity: structuredClone(identity), card }),
        lookup: async () => [record],
        fetchRawComps: async () => soldPrices.map((price, index) => ({
            id: index, listing_url: 'https://www.ebay.com/itm/' + (123456789100 + index), title: listing.title + ' LP',
            price, currency: 'USD', attribution: 'exact', sale_type: 'fixed_price', sold_at: new Date(now - (index + 1) * 86400000).toISOString(),
            variant: 'Unlimited Holofoil', grader: null, grade: null, grade_qualifier: null })),
        fetchComps: async () => [], fetchCachedComps: async () => [], compChecks: async () => new Map(),
        soldCondition: () => ({
            read: async (sale: { id: number }) => observedWear && {
                condition: observedWear === 'MIXED' ? (sale.id === 0 ? 'NEAR_MINT' : 'LIGHTLY_PLAYED') : observedWear,
                evidence: ['Photo review of front and back'], photoCount: 2 },
            status: () => observedWear ? 'REVIEWED' : 'UNREVIEWED',
            usage: [], acquire: async () => { acquisitions++; return acquireWear ? { condition: 'LIGHTLY_PLAYED', evidence: ['Both faces show light wear'], photoCount: 2 } : null; },
        }) as any,
        tcgplayer: async (_card,_identity,wear) => { tcgCalls++; assert.equal(wear,'LIGHTLY_PLAYED'); return quote; } });
    const e = await evaluate(listing.id, { targets: { minProfit: 0, minRoi: 0 } });
    assert.ok(tcgCalls > 0);
    if (acquireWear) assert.equal(acquisitions, soldPrices.length === 1 ? 0 : Math.min(3, soldPrices.length));
    if (observedWear || !soldPrices.length) assert.equal(acquisitions, 0);
    return e;
}

test('a TCGplayer-only quote is retained as a comparison', async () => {
    const e = await evaluateWithQuote();
    assert.equal(e.rawPricing?.tcgplayerReference?.price,70);
    assert.equal(e.underwriting?.verdict,'CANT_PRICE');
});

test('a high TCGplayer ask cannot turn a loss at matched raw eBay sales into a flip', async () => {
    const e = await evaluateWithQuote([14, 15, 16]);
    const raw = e.underwriting!.paths.find(path => path.path === 'RAW');
    assert.ok(raw?.status === 'PRICED');
    assert.equal(raw.salePrice, 15);
    assert.ok(raw.profit < 0);
    assert.ok(!e.underwriting!.verdict.startsWith('BUY'));
    assert.equal(e.rawPricing?.conditionEvidence, 'AI_PHOTOS');
    const display = listingMarketPrices(e, { ...e.listing, images: e.listing.photos! }, now);
    assert.equal(display?.tcg?.delivered, 70);
    assert.equal(display?.sold?.price, 15);
    assert.ok(currentPriceEvidence(e, now));

    const old = await evaluateWithQuote();
    old.rawPricing!.prices = [{ condition: 'LIGHTLY_PLAYED', basis: 'TCGPLAYER_OFFERS', price: 70, offers: old.rawPricing!.tcgplayerReference }];
    old.pricingVersion = 'condition-resale-19';
    old.rawPricing!.ebayComps = e.rawPricing!.ebayComps;
    assert.equal(currentPriceEvidence(old, now), false, 'refresh an older stored flip based on the higher ask');
});

test('photo-matched eBay sales lead even when TCGplayer has a lower asking price', async () => {
    const e = await evaluateWithQuote([95, 100, 108, 195]);
    const raw = e.underwriting!.paths.find(path => path.path === 'RAW');
    assert.ok(raw?.status === 'PRICED');
    assert.equal(raw.salePrice, 101);
    assert.equal(e.rawPricing?.prices?.[0].comps?.dropped["price far from the other sales"], 1);
    const display = listingMarketPrices(e, { ...e.listing, images: e.listing.photos! }, now);
    assert.equal(display?.sold?.price, 101);
    assert.equal(display?.sold?.filteredMean, true);
    assert.deepEqual(display?.sold?.average, { count: 3, fixedPrice: true, days: 30 });
    assert.equal(display?.sold?.sales30, 4);
    const previous = await evaluateWithQuote();
    previous.rawPricing!.prices = [{ condition: 'LIGHTLY_PLAYED', basis: 'TCGPLAYER_OFFERS', price: 70, offers: previous.rawPricing!.tcgplayerReference }];
    previous.pricingVersion = 'condition-resale-19';
    previous.rawPricing!.ebayComps = e.rawPricing!.ebayComps;
    assert.equal(currentPriceEvidence(previous, now), false);
    assert.equal(display?.tcg?.delivered, 70);
});

test('seller descriptions and photo-verified worse wear cannot replace the assessed condition price', async () => {
    for (const wear of [null, 'MODERATELY_PLAYED'] as const) {
        const e = await evaluateWithQuote([14, 15, 16], wear);
        assert.equal(e.rawPricing?.tcgplayerReference?.price, 70);
        assert.equal(e.rawPricing?.prices?.find(row => row.condition === 'LIGHTLY_PLAYED'), undefined);
        assert.ok(currentPriceEvidence(e, now));
        const comparisons = listingMarketPrices(e, { ...e.listing, images: e.listing.photos! }, now);
        assert.equal(comparisons?.tcg?.delivered, 70);
        if (wear === null) assert.equal(comparisons?.sold?.sellerCondition, true);
    }
});

test('an active ask cannot trigger a paid photo check of an otherwise losing sale', async () => {
    const e = await evaluateWithQuote([15], null, true);
    assert.equal(e.rawPricing?.prices?.length ?? 0, 0);
    assert.equal(e.rawPricing?.tcgplayerReference?.price, 70);
    assert.ok(!e.underwriting!.verdict.startsWith('BUY'));
});

test('a lone photo-matched premium prompts checks of the cheaper cluster before setting resale', async () => {
    const e = await evaluateWithQuote([120, 49, 50], null, true);
    const price = e.rawPricing!.prices![0];
    assert.equal(price.price, 49.5);
    assert.equal(price.comps?.count, 2);
    assert.equal(price.comps?.activitySales?.length, 3);
    assert.equal(e.rawPricing?.tcgplayerReference?.price, 70);
});

test('the high sale of a cleaner copy stays in its own condition market', async () => {
    const e = await evaluateWithQuote([150, 48, 50], 'MIXED');
    const rows = e.rawPricing!.prices!;
    assert.equal(rows.find(row => row.condition === 'NEAR_MINT')?.price, 150);
    assert.equal(rows.find(row => row.condition === 'LIGHTLY_PLAYED')?.price, 49);
    assert.equal(e.underwriting!.paths.find(path => path.path === 'RAW')?.salePrice, 49);
});
