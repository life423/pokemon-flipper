import { analysisPriority, comparePriority } from "../../shared/analysis-priority.ts";
import { cents, meetsMoneyTargets } from "../../shared/money/cents.ts";
import { acquisitionCost, netFromSale } from "../../shared/money/underwriting.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { soldMarketPrice, usableGradingLead, usableSoldReference } from "../../shared/sold-evidence.ts";
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
        if (potential || usableGradingLead(row)) funded.push(row);
        else if (row.mistakes?.length || row.screen?.priceAnomaly ||
            row.screen?.incomplete && /\d+\s*\/\s*\d+/.test(row.title)) overlooked.push(row);
        else other.push(row);
    }
    // Give imperfect listings a photo check while bounding speculative paid work.
    // Use a fresh page for new opportunities after these hypotheses have been tested.
    const seen = new Set<string>();
    const distinct = (pool: ListingSummary[], count: number) => {
        const picks: ListingSummary[] = [];
        for (const row of pool) {
            const key = discoveryMarketKey(row);
            if (seen.has(key)) continue;
            seen.add(key);
            picks.push(row);
            if (picks.length === count) break;
        }
        return picks;
    };
    return [...distinct(funded, 8), ...distinct(overlooked, 2), ...distinct(other, 1)];
}
