import { lookupCards } from "./price-tracker.ts";
import { normalizeWords, sameCardNumber, sameSetFamily } from "../identity/card-identity.ts";
import { pricingSearchName } from "./search-name.ts";
import type { Identity, RawPricing } from "../../shared/types.ts";

// PkmnPrices remains primary. A second market-data API can challenge its raw
// fallback, but is not independent evidence of an actual eBay transaction.
export async function crossCheckRawPrices(pricing: RawPricing, identity: Identity, lookup = lookupCards): Promise<RawPricing> {
    if (pricing.status !== "PRICED" || !pricing.prices?.some(price => price.basis === "TCGPLAYER") || !identity.name || !identity.set || !identity.cardNumber || !["HOLO", "NON_HOLO", "REVERSE_HOLO"].includes(identity.finish)) return pricing;
    try {
        const records = await lookup({ name: pricingSearchName(identity.name), set: identity.set });
        const matches = records.filter(record => sameSetFamily(record.setName, identity.set) && sameCardNumber(record.cardNumber, identity.cardNumber) && normalizeWords(record.name) === normalizeWords(identity.name));
        const variants = matches.flatMap(record => record.variants).filter(variant => variant.printing === identity.printing && variant.finish === identity.finish);
        if (variants.length !== 1) return { ...pricing, crossCheckNote: "PokémonPriceTracker did not provide one exact printing/finish match; its prices were not substituted." };
        return { ...pricing, prices: pricing.prices.map(price => {
            const check = variants[0].prices.find(entry => entry.condition === price.condition && Number.isFinite(entry.price) && entry.price > 0);
            const age = Date.now() - Date.parse(check?.updatedAt ?? "");
            return price.basis === "TCGPLAYER" && check && age >= 0 && age < 72 * 3600000
                ? { ...price, crossCheck: { source: "pokemonPriceTracker" as const, price: check.price, updatedAt: check.updatedAt } } : price;
        }), crossCheckNote: "PokémonPriceTracker checked the same card, printing, finish and condition. Both market feeds can share TCGplayer data; this is not another eBay sold sample." };
    } catch { return { ...pricing, crossCheckNote: "The secondary market-price check was unavailable. Primary PkmnPrices evidence was kept." }; }
}
