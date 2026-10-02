import { dollars } from "../format.ts";
import type { AuctionOutlook, CompSummary, MoneyPath, UsualPrice } from "../types.ts";

// An auction ends near what the card usually sells for, whatever its
// bid is days before the end. So for an auction the useful question
// isn't whether today's bid is under your max bid, but how often this
// card actually sells that low.

// Raw cards have a market price but no list of sales: a max bid within
// this share of it is possible.
const RAW_POSSIBLE_SHARE = 0.8;

// Slabs: at least this share of recent sales at or under the max bid
// is possible.
const SALES_POSSIBLE_SHARE = 0.2;

// What the listing usually sells for, as listed: a slab's recent sales
// at its grade, or a raw card's market price in its condition.
export function usualPrice(paths: MoneyPath[], slabSales: CompSummary | null | undefined): UsualPrice | null {
    if (slabSales) {
        return slabSales.median ? { price: slabSales.median, sales: slabSales.sales.map((sale) => sale.price) } : null;
    }

    const raw = paths.find((path) => path.path === "RAW");

    return raw?.status === "PRICED" && raw.salePrice ? { price: raw.salePrice } : null;
}

export function auctionOutlook(maxBid: number, usual: UsualPrice): AuctionOutlook {
    if (usual.sales && usual.sales.length > 0) {
        const sorted = [...usual.sales].sort((a, b) => a - b);
        const atOrUnder = sorted.filter((price) => price <= maxBid).length;

        return {
            chance:
                maxBid >= usual.price
                    ? "LIKELY"
                    : atOrUnder / sorted.length >= SALES_POSSIBLE_SHARE
                      ? "POSSIBLE"
                      : "LONG_SHOT",
            usualPrice: usual.price,
            salesAtOrUnder: atOrUnder,
            salesTotal: sorted.length,
        };
    }

    const share = maxBid / usual.price;

    return {
        chance: share >= 1 ? "LIKELY" : share >= RAW_POSSIBLE_SHARE ? "POSSIBLE" : "LONG_SHOT",
        usualPrice: usual.price,
        salesAtOrUnder: null,
        salesTotal: null,
    };
}

// An auction that will very likely end above the max bid.
export function isLongShot(auction: boolean, usual: UsualPrice | null | undefined, maxBid: number): boolean {
    return auction && usual != null && auctionOutlook(maxBid, usual).chance === "LONG_SHOT";
}

// One plain sentence for the page.
export function describeOutlook(outlook: AuctionOutlook, maxBid: number): string {
    const usual = `It usually sells for about ${dollars(outlook.usualPrice)}`;
    const sales =
        outlook.salesTotal !== null
            ? `; ${outlook.salesAtOrUnder} of ${outlook.salesTotal} recent sales went for ${dollars(maxBid)} or less`
            : "";

    if (outlook.chance === "LIKELY") {
        return outlook.profitAtUsual != null
            ? `${usual}; winning there would make about ${dollars(outlook.profitAtUsual)}.`
            : `${usual}, and even that clears your targets.`;
    }
    if (outlook.chance === "POSSIBLE") return `${usual}${sales}, so winning at your max bid is possible, not likely.`;

    return `${usual}${sales}, so this auction will very likely end above your max bid.`;
}
