export const AUCTION_OPPORTUNITY_HOURS = 10;

export function withinOpportunityWindow(endTime: string | null | undefined, now: number): boolean {
    const remaining = Date.parse(endTime ?? "") - now;
    return remaining > 0 && remaining < AUCTION_OPPORTUNITY_HOURS * 3_600_000;
}
