import '../fixtures/isolated-data.ts';
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

for (const scenario of ["confirmed competition", "lower verified eBay sale", "higher verified eBay sale", "single seller", "no condition quote"] as const)
test("bounded raw resale pricing with " + scenario, async () => {
    let acquisitions = 0, tcgCalls = 0;
    const saved = new Map<string, any>();
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
