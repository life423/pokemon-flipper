import { dollars } from "../format.ts";
import type { AuctionOutlook, CompSummary, MoneyPath, UsualPrice } from "../types.ts";
import { soldMarketPrice } from "../sold-evidence.ts";

// Auction outcomes are a better bid reference when available. A market
// reference still helps when we only have other formats or a raw price.
export function usualPrice(paths: MoneyPath[], slabSales: CompSummary | null | undefined): UsualPrice | null {
    if (slabSales) {
        const auctions = slabSales.sales.filter((sale) => sale.saleType === "auction")
            .map((sale) => sale.price).sort((a, b) => a - b);
        if (auctions.length) {
            const middle = Math.floor(auctions.length / 2);
            const price = auctions.length % 2 ? auctions[middle] : (auctions[middle - 1] + auctions[middle]) / 2;
            return { price, sales: auctions };
        }
        const price = soldMarketPrice(slabSales);
        return price === null ? null : { price, sales: slabSales.sales.map((sale) => sale.price) };
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
