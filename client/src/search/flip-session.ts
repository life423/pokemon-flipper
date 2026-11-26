import { validShippingZip } from "../../../shared/shipping-zip.ts";
import type { SearchPlan } from "../../../shared/search-plan.ts";
import type { ListingFilters } from "../../../shared/listing-filters.ts";
import type { BuyingOption, Targets } from "../../../shared/types.ts";
import type { GuidedHuntLeg } from "./guided-hunt";

// Store only the submitted settings and accepted plan. Prices and purchase decisions
// must be checked by the server under the original account whenever the search resumes.
export interface FlipSession {
    id: string;
    destination: string | null;
    text: string;
    format: BuyingOption | "all";
    expand: boolean;
    filters: ListingFilters;
    targets: Targets;
    minGrade: number;
    prepared?: { plan: SearchPlan | null; legs: GuidedHuntLeg[] };
}

const key = "pokemon-flipper:active-flip:v1";
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
export function readFlipSession(): FlipSession | null {
    try {
        const saved: FlipSession | null = JSON.parse(sessionStorage.getItem(key) ?? "null");
        if (!saved || !uuid.test(saved.id) || typeof saved.text !== "string" || typeof saved.expand !== "boolean" ||
            !["FIXED_PRICE", "AUCTION", "all"].includes(saved.format) || !saved.filters ||
            !Number.isFinite(saved.targets?.minProfit) || !Number.isFinite(saved.targets?.minRoi) || !Number.isFinite(saved.minGrade) ||
            !(saved.destination === null || validShippingZip(saved.destination))) return null;
        if (saved.prepared && (!Array.isArray(saved.prepared.legs) || !saved.prepared.legs.length || saved.prepared.legs.length > 2 ||
            saved.prepared.legs.some(leg => !uuid.test(leg.id) || !["FIXED_PRICE", "AUCTION"].includes(leg.format)))) return null;
        return saved;
    } catch { return null; }
}

export function writeFlipSession(session: FlipSession | null) {
    try {
        if (session) sessionStorage.setItem(key, JSON.stringify(session));
        else sessionStorage.removeItem(key);
    } catch { /* The current tab can continue in memory when browser storage is unavailable. */ }
}
