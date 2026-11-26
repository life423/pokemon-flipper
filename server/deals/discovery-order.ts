import { resaleActivity } from "../analysis/resale-activity.ts";
import { observedSoldSales } from "../../shared/sales-activity.ts";
import { analysisPriority, comparePriority } from "../../shared/analysis-priority.ts";
import { cents, meetsMoneyTargets } from "../../shared/money/cents.ts";
import { acquisitionCost, maxBid, netFromSale } from "../../shared/money/underwriting.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { hasExactSoldScope, soldMarketPrice, usableGradingLead, usableSoldReference } from "../../shared/sold-evidence.ts";
import type { ListingSummary, Targets } from "../../shared/types.ts";

// These are provisional seller/catalog labels for ordering research, never
// physical identity or a valuation. Keep every copy available in continuation.
export function discoveryMarketKey(row: ListingSummary) {
    const card = row.screen?.card;
    if (!card?.name || !card.set || !card.cardNumber) return row.id;
    return JSON.stringify([card.name.toLowerCase(), card.set.toLowerCase(), card.cardNumber.toLowerCase(),
        card.printing, row.listedAttributes?.finish, row.isGraded, row.listedAttributes?.grader, row.listedAttributes?.grade]);
}

export function orderBroadDiscovery(rows: ListingSummary[], targets: Targets | undefined, now: number): ListingSummary[] {
    const prioritized = rows.map((row, index) => ({ row, priority: analysisPriority(row, targets, now), index }));
    const compareRows = (a: typeof prioritized[number], b: typeof prioritized[number]) =>
        Number(b.row.shipping !== null) - Number(a.row.shipping !== null) || comparePriority(a.priority, b.priority) || a.index - b.index;
    // Pick the strongest quoted copy within a research band before assigning
    // positions to markets. Once assigned, each kind's position is unique.
    prioritized.sort((a, b) => b.priority.band - a.priority.band || compareRows(a, b));
    const markets = new Map<string, number>();
    const kinds = new Map<string, number>();
    const ranked = prioritized.map(entry => {
        const { row, priority: { band } } = entry;
        const market = `${band}:${discoveryMarketKey(row)}`;
        const round = markets.get(market) ?? 0;
        markets.set(market, round + 1);
        const kind = `${band}:${round}:${row.isGraded ? "slab" : "raw"}`;
        const position = kinds.get(kind) ?? 0;
        kinds.set(kind, position + 1);
        return { ...entry, band, round, position };
    });
    ranked.sort((a, b) => b.band - a.band || a.round - b.round || a.position - b.position ||
        compareRows(a, b));
    return ranked.map(({ row }) => row);
}

// Research priority only. A poor title can conceal a card, but better marketing
// never adds a premium to its estimated resale value.
export const resaleReviewBand = { belowTarget: 0, unresolved: 1, possibleUpside: 2, matchedUpside: 3 } as const;
export type ResaleReviewBand = typeof resaleReviewBand[keyof typeof resaleReviewBand];

export function resaleReviewPriority(row: ListingSummary, targets: Targets, now: number): ResaleReviewBand {
    const evidence = row.screen?.soldEvidence;
    const card = row.screen?.card;
    const cost = row.currentPrice == null || row.shipping == null ? null : acquisitionCost(row.currentPrice, row.shipping, MONEY_CONFIG.buying);
    let priced = false;
    let possibleUpside = false;
    // An exact query can return public prices even for an unidentified copy.
    // A partial number alone is shared by many sets and cannot support priority.
    const anchored = evidence?.exactScope || card?.cardNumber?.includes("/") || card?.set && (card.name || card.cardNumber);
    if (evidence && anchored && cost !== null) {
        for (const ref of evidence.references) {
            if (!usableSoldReference(ref, row.isGraded)) continue;
            const age = now - Date.parse(ref.summary.newestSale ?? "");
            if (!(age >= 0 && age <= 60 * 86_400_000)) continue;
            priced = true;
            const net = netFromSale(soldMarketPrice(ref.summary)!, row.isGraded ? "graded" : "raw", MONEY_CONFIG.selling);
            if (meetsMoneyTargets(cents(net), cents(cost), targets.minProfit, targets.minRoi)) {
                if ((row.isGraded || ref.condition) && hasExactSoldScope(evidence, row.screen?.card?.printing))
                    return resaleReviewBand.matchedUpside;
                possibleUpside = true;
            }
        }
    }
    if (possibleUpside || usableGradingLead(row)) return resaleReviewBand.possibleUpside;
    if (row.mistakes?.length || row.screen?.priceAnomaly) return resaleReviewBand.unresolved;
    return priced ? resaleReviewBand.belowTarget : resaleReviewBand.unresolved;
}

export function freshResaleCandidates(rows: ListingSummary[], targets: Targets, now: number) {
    const funded: ListingSummary[] = [], overlooked: ListingSummary[] = [], other: ListingSummary[] = [], below: ListingSummary[] = [];
    const priorities = new Map<string, number>();
    for (const row of orderBroadDiscovery(rows, targets, now)) {
        if (!row.images.some(Boolean) || row.currentPrice == null) continue;
        const references = row.screen?.soldEvidence?.references ?? [];
        const band = resaleReviewPriority(row, targets, now);
        // Compare transactions within one condition/grade and printing at a time.
        // This only orders checks. The pictured copy still needs to match the market.
        const evidence = row.screen?.soldEvidence;
        const exact = evidence && hasExactSoldScope(evidence, row.screen?.card?.printing);
        for (const ref of exact ? references : []) {
            if (!usableSoldReference(ref, row.isGraded) || !row.isGraded && !ref.condition) continue;
            const activity = resaleActivity(observedSoldSales(ref.summary.sales ?? [], now,
                { maxDays: 60, slab: row.isGraded }));
            if (!activity) continue;
            // Rank potential buying room at the lower quartile of this market.
            // Never turn preliminary condition or a premium printing into a buy.
            const ceiling = row.shipping === null ? 0 : maxBid({
                expectedNet: netFromSale(activity.low, row.isGraded ? "graded" : "raw", MONEY_CONFIG.selling),
                fixedCosts: 0, shipping: row.shipping,
            }, { ...MONEY_CONFIG, targets });
            const headroom = ceiling > 0 ? Math.max(0, (ceiling - row.currentPrice) / ceiling) : 0;
            priorities.set(row.id, Math.max(priorities.get(row.id) ?? 0, activity.priority * (1 + headroom)));
        }
        if (band >= resaleReviewBand.possibleUpside) funded.push(row);
        else if (band === resaleReviewBand.belowTarget) below.push(row);
        else if (row.mistakes?.length || row.screen?.priceAnomaly ||
            row.screen?.incomplete && /\d+\s*\/\s*\d+/.test(row.title)) overlooked.push(row);
        else other.push(row);
    }
    // Diversify the first checks without discarding another physical copy.
    // Its condition may make it the profitable one even when its title and
    // provisional market match a copy already checked. The caller's bounded
    // review batch controls concurrency; it is not a lifetime candidate limit.
    for (const tier of [funded, overlooked, other, below]) {
        tier.sort((a, b) => (priorities.get(b.id) ?? 0) - (priorities.get(a.id) ?? 0));
        // Preserve each market's turns. Prefer the cheaper copy only among
        // otherwise identical seller claims with comparable research evidence.
        const slots = new Map<string, number[]>();
        tier.forEach((row, index) => {
            if (row.shipping === null || !row.screen?.card?.cardNumber) return;
            const key = JSON.stringify([discoveryMarketKey(row), row.title.trim().toLowerCase(), row.cardCondition,
                row.screen.status, row.screen.soldEvidence?.status, priorities.get(row.id), row.conditionNotes]);
            const group = slots.get(key) ?? [];
            group.push(index);
            slots.set(key, group);
        });
        for (const group of slots.values()) {
            if (group.length < 2) continue;
            const ordered = group.map(index => tier[index]).sort((a,b) => (a.currentPrice! + a.shipping!) - (b.currentPrice! + b.shipping!));
            group.forEach((slot, index) => { tier[slot] = ordered[index]; });
        }
    }
    const priority = [...funded.slice(0, 8), ...overlooked.slice(0, 2), ...other.slice(0, 1)];
    const selected = new Set(priority.map(row => row.id));
    return [...priority, ...[...funded, ...overlooked, ...other, ...below].filter(row => !selected.has(row.id))];
}
