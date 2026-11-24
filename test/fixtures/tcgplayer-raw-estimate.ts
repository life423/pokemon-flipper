import type { RawPrice } from "../../shared/types.ts";

export function tcgplayerRawEstimate(price = 100, checkedAt = new Date().toISOString()): RawPrice {
    return { basis: "TCGPLAYER_MARKET", condition: "LIGHTLY_PLAYED", price, updatedAt: checkedAt,
        offers: { source: "TCGPLAYER", currency: "USD", condition: "LIGHTLY_PLAYED", printing: "Unlimited Holofoil",
            checkedAt, snapshotAt: checkedAt, method: "CONDITION_MARKET", marketCondition: "Lightly Played",
            marketPrice: price, marketRecordAt: checkedAt, price, low: price, median: price, high: price, sellerCount: 0, offers: [] } };
}
