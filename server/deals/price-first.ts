import { createSoldScreening } from "../pricing/screening-sales.ts";
import { applySoldPriceScreen } from "../../shared/money/sold-screen.ts";
import { comparePriority, analysisPriority } from "../../shared/analysis-priority.ts";
import { CHEAP_FIRST_EDITION_BASE_SET_LIMIT } from "../../shared/research-policy.ts";
import { sameSetFamily } from "../identity/card-identity.ts";
import { mapLimit } from "../lib/concurrency.ts";
import type { ListingSummary, SearchIntent, Targets } from "../../shared/types.ts";

export type SoldScreeningFactory = typeof createSoldScreening;
interface PriceFirstOptions { signal?: AbortSignal; targets?: Targets; includeOffers?: boolean; now?: number }

// Finish shared market research before emitting photo-ready candidates. This
// prevents the browser buying the first few assessments while stronger priced
// candidates are still waiting for the same market page.
export function createPriceFirstSession(intent: SearchIntent, {
    signal, targets, includeOffers = false, now = Date.now(),
}: PriceFirstOptions = {}, createScreening: SoldScreeningFactory = createSoldScreening) {
    signal?.throwIfAborted();
    const stopped = new AbortController();
    const workSignal = signal ? AbortSignal.any([signal, stopped.signal]) : stopped.signal;
    const screen = createScreening({ signal: workSignal, now: () => now });
    // Refill batches share the same source allowance, memoized catalog/markets
    // and cancellation signal. A new batch never renews a provider allowance.
    return async (listings: ListingSummary[]): Promise<ListingSummary[]> => {
        workSignal.throwIfAborted();
        let priced: ListingSummary[];
        try { priced = await mapLimit(listings, 4, async listing => {
            workSignal.throwIfAborted();
            let evidence;
            // Abort siblings before releasing this worker's slot. Otherwise a
            // queued request can start between its rejection and Promise.all's
            // catch handler, including after a storage failure.
            try { evidence = await screen(listing, intent); }
            catch (error) { stopped.abort(error); throw error; }
            workSignal.throwIfAborted();
            let candidate = listing;
            const card = listing.screen?.card;
            const cheapEditionLead = !listing.isGraded && listing.currentPrice !== null && listing.currentPrice >= 0 &&
                listing.currentPrice <= CHEAP_FIRST_EDITION_BASE_SET_LIMIT &&
                sameSetFamily(card?.set ?? (intent.sets.length === 1 ? intent.sets[0] : null), "Base Set") &&
                (card?.printing === "FIRST_EDITION" || intent.printing === "FIRST_EDITION");
            if (cheapEditionLead && listing.screen) candidate = { ...listing, screen: { ...listing.screen, focusedReview: "CHEAP_FIRST_EDITION_BASE_SET" } };
            return applySoldPriceScreen(candidate, evidence, { targets, includeOffers });
        }); } catch (error) { stopped.abort(error); throw error; }
        signal?.throwIfAborted();
        // Stable ties preserve newest-listing/source order. This ranks preliminary
        // evidence only; it never creates a final Deal or an estimated grade.
        return priced.sort((a, b) => Number(a.screen?.status === "DROPPED") - Number(b.screen?.status === "DROPPED") ||
            comparePriority(analysisPriority(a, targets), analysisPriority(b, targets)));
    };
}

export async function priceFirstListings(listings: ListingSummary[], intent: SearchIntent,
    options: PriceFirstOptions = {}, createScreening: SoldScreeningFactory = createSoldScreening): Promise<ListingSummary[]> {
    return createPriceFirstSession(intent, options, createScreening)(listings);
}
