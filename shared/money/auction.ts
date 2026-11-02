import { dollars } from "../format.ts";
import type { AuctionOutlook, CompSummary, MoneyPath, UsualPrice } from "../types.ts";

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
        const atOrUnder = usual.sales.filter((price) => price <= maxBid).length;

        return {
            usualPrice: usual.price,
            salesAtOrUnder: atOrUnder,
            salesTotal: usual.sales.length,
        };
    }

    return {
        usualPrice: usual.price,
        salesAtOrUnder: null,
        salesTotal: null,
    };
}

// One plain sentence for the page.
export function describeOutlook(outlook: AuctionOutlook, maxBid: number): string {
    const usual = `Your item-bid limit is ${dollars(maxBid)}. The market reference is about ${dollars(outlook.usualPrice)}`;
    const sales =
        outlook.salesTotal !== null
            ? `; ${outlook.salesAtOrUnder} of ${outlook.salesTotal} observed sales went for ${dollars(maxBid)} or less`
            : "";

    const profit = outlook.profitAtUsual != null ? ` At that reference price, estimated profit would be ${dollars(outlook.profitAtUsual)}.` : "";
    return `${usual}${sales}.${profit}`;
}
