import { listingCacheKey, type ListingDetails } from "../../server/ebay/listings.ts";
import { VISION_MODEL } from "../../server/ai/policy.ts";
import { CONDITION_RULES_VERSION, type RawCondition } from "../../shared/conditions.ts";
import type { Comp } from "../../server/pricing/types.ts";
import type { SoldConditionReading } from "../../server/ai/sold-condition.ts";

// Seed existing, independently accepted sold-copy photo evidence. These
// fixtures let bounded tests prove a completed raw route without any historical
// photo download or new condition assessment.
export function seedRawSoldCopies(cache: Map<string, unknown>, listing: ListingDetails, condition: RawCondition, price: number, now: number): Comp[] {
    return [0, 1, 2].map(index => {
        const ebayId = String(923456789010 + index);
        const photos = ["front", "back"].map(side => `https://i.ebayimg.com/images/g/offline-${ebayId}-${side}/s-l1600.jpg`);
        cache.set(listingCacheKey(`v1|${ebayId}|0`), { ...listing, id: `v1|${ebayId}|0`, url: `https://www.ebay.com/itm/${ebayId}`, images: photos });
        const reading: SoldConditionReading = {
            card: { name: "Venusaur", set: "Base Set", cardNumber: "15/102", language: "English", finish: "HOLO", confidence: "HIGH",
                evidence: ["Readable name, set and collector number on this sold copy"] },
            printing: "UNLIMITED", condition, confidence: "HIGH", oneRawCard: true, frontVisible: true, backVisible: true,
            closeUps: false, structuralDamage: condition === "DAMAGED", evidence: ["Accepted offline sold-copy condition finding"], limitations: [],
        };
        const target = JSON.stringify(["Venusaur", "Base Set", "15/102", "UNLIMITED", "HOLO"]);
        cache.set(`sold-condition:v${CONDITION_RULES_VERSION}:${VISION_MODEL}:${target}:${JSON.stringify(photos)}`, reading);
        return { id: ebayId, title: "Venusaur Base Set 15/102 Unlimited Holo English", price,
            currency: "USD", sold_at: new Date(now - (index + 1) * 86400000).toISOString(), variant: "Holofoil", attribution: "exact",
            sale_type: "fixed_price", listing_url: `https://www.ebay.com/itm/${ebayId}`, grader: null, grade: null, grade_qualifier: null };
    });
}
