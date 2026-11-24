import { cents } from "../../../shared/money/cents.ts";
import { acquisitionCost } from "../../../shared/money/underwriting.ts";
import { MONEY_CONFIG } from "../../../shared/money/config.ts";
import { verifiedSlabMarketKey } from "../../../shared/slab-market.ts";
import { searchPhotosFitDetails } from "../../../shared/listing-evidence.ts";
import type { AnalysisState } from "../analysis-state.ts";
import type { ListingSummary, SearchIntent } from "../types.ts";
import { eligibleAssessedListing, checkedTerms } from "./results.ts";

export const resaleVenues = ["Fanatics Collect", "Whatnot", "Shopify"] as const;
export type ResaleVenue = typeof resaleVenues[number];
export interface ResaleReceipt {
    market: string;
    venue: ResaleVenue;
    reference: string;
    soldOn: string;
    payout: number;
    fulfillment: number;
}

export const receiptPrefix = "pokemon-flipper:resale-receipt:v1:";
export function receiptKey(receipt: Pick<ResaleReceipt, "venue" | "reference">) {
    return receiptPrefix + JSON.stringify([receipt.venue, receipt.reference]);
}

function isAmount(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(cents(value)) && value >= 0 && cents(value) / 100 === value;
}

export function validReceipt(input: unknown): input is ResaleReceipt {
    if (!input || typeof input !== "object") return false;
    const r = input as Partial<ResaleReceipt>;
    if (typeof r.soldOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.soldOn)) return false;
    const day = new Date(r.soldOn + "T00:00:00Z");
    return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === r.soldOn &&
        typeof r.market === "string" && r.market.length > 0 && r.market.length <= 1000 &&
        resaleVenues.includes(r.venue as ResaleVenue) && typeof r.reference === "string" &&
        !!r.reference.trim() && r.reference.trim() === r.reference && r.reference.length <= 100 &&
        isAmount(r.payout) && r.payout > 0 && isAmount(r.fulfillment);
}

export function readResaleReceipts(storage: Storage): ResaleReceipt[] {
    const receipts: ResaleReceipt[] = [];
    for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (!key?.startsWith(receiptPrefix)) continue;
        const raw = storage.getItem(key);
        if (raw === null) continue;
        const value: unknown = JSON.parse(raw);
        if (!validReceipt(value) || receiptKey(value) !== key) throw new Error("Invalid saved sale.");
        receipts.push(value);
    }
    return receipts;
}

export function compareResaleReceipts(listing: ListingSummary, state: AnalysisState | undefined,
    receipts: readonly ResaleReceipt[], now: number, intent?: SearchIntent | null) {
    const assessment = eligibleAssessedListing(listing, state, intent, now);
    if (!assessment || listing.title.trim() !== assessment.listing.title.trim() ||
        !searchPhotosFitDetails(listing.images, assessment.listing.photos ?? [])) return [];
    const market = verifiedSlabMarketKey(assessment);
    const terms = checkedTerms(listing, assessment, now);
    if (!market || !terms) return [];
    const cost = acquisitionCost(terms.price, terms.shipping, MONEY_CONFIG.buying);
    const matching = receipts.filter(r => {
        const age = now - Date.parse(r.soldOn + "T00:00:00Z");
        return r.market === market && age >= 0 && age < 90 * 86_400_000;
    });
    return resaleVenues.flatMap(venue => {
        const rows = matching.filter(r => r.venue === venue)
            .sort((a, b) => b.soldOn.localeCompare(a.soldOn) || netCents(a) - netCents(b));
        if (!rows.length) return [];
        // Use the lower net if the most recent sale day has multiple receipts.
        const latest = rows[0];
        const net = netCents(latest);
        return [{ receipt: latest, count: rows.length, cost, proceeds: net / 100, margin: (net - cents(cost)) / 100 }];
    });
}
function netCents(r: ResaleReceipt) { return cents(r.payout) - cents(r.fulfillment); }
