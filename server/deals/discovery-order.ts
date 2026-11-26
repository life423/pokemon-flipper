import { resaleActivity } from "../analysis/resale-activity.ts";
import { observedSoldSales } from "../../shared/sales-activity.ts";
import { analysisPriority, comparePriority } from "../../shared/analysis-priority.ts";
import { cents, meetsMoneyTargets } from "../../shared/money/cents.ts";
import { acquisitionCost, netFromSale } from "../../shared/money/underwriting.ts";
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
export function freshResaleCandidates(rows: ListingSummary[], targets: Targets, now: number) {
    const funded: ListingSummary[] = [], overlooked: ListingSummary[] = [], other: ListingSummary[] = [];
    const priorities = new Map<string, number>();
    for (const row of orderBroadDiscovery(rows, targets, now)) {
        if (!row.images.some(Boolean) || row.currentPrice == null) continue;
        const cost = row.shipping === null ? null : acquisitionCost(row.currentPrice, row.shipping, MONEY_CONFIG.buying);
        const references = row.screen?.soldEvidence?.references ?? [];
        const potential = cost !== null && references.some(ref => {
            if (!usableSoldReference(ref, row.isGraded)) return false;
            const date = Date.parse(ref.summary.newestSale ?? "");
            if (!(date <= now && now - date <= 60 * 86_400_000)) return false;
            const net = netFromSale(soldMarketPrice(ref.summary)!, row.isGraded ? "graded" : "raw", MONEY_CONFIG.selling);
            return meetsMoneyTargets(cents(net), cents(cost), targets.minProfit, targets.minRoi);
        });
        // Compare transactions within one condition/grade and printing at a time.
        // This only orders checks. The pictured copy still needs to match the market.
        const evidence = row.screen?.soldEvidence;
        const exact = evidence && hasExactSoldScope(evidence, row.screen?.card?.printing);
        for (const ref of exact ? references : []) {
            if (!usableSoldReference(ref, row.isGraded) || !row.isGraded && !ref.condition) continue;
            const activity = resaleActivity(observedSoldSales(ref.summary.activitySales ?? ref.summary.sales ?? [], now,
                { maxDays: 60, slab: row.isGraded }));
            if (activity) priorities.set(row.id, Math.max(priorities.get(row.id) ?? 0, activity.priority));
        }
        if (potential || usableGradingLead(row)) funded.push(row);
        else if (row.mistakes?.length || row.screen?.priceAnomaly ||
            row.screen?.incomplete && /\d+\s*\/\s*\d+/.test(row.title)) overlooked.push(row);
        else other.push(row);
    }
    // Diversify the first checks without discarding another physical copy.
    // Its condition may make it the profitable one even when its title and
    // provisional market match a copy already checked. The caller's bounded
    // review batch controls concurrency; it is not a lifetime candidate limit.
    for (const tier of [funded, overlooked, other]) tier.sort((a, b) => (priorities.get(b.id) ?? 0) - (priorities.get(a.id) ?? 0));
    const priority = [...funded.slice(0, 8), ...overlooked.slice(0, 2), ...other.slice(0, 1)];
    const selected = new Set(priority.map(row => row.id));
    return [...priority, ...[...funded, ...overlooked, ...other].filter(row => !selected.has(row.id))];
}
