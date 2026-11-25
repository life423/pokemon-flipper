import type { ListingMarketPrices } from "../../../shared/listing-market-prices.ts";
import { dollars } from "../format";
import styles from "./MarketPrices.module.css";

export function MarketPrices({ prices, now }: { prices?: ListingMarketPrices; now: number }) {
    if (!prices || prices.validUntil <= now) return <p className={styles.empty}>No matched resale prices available</p>;
    const { sold, tcg, scope } = prices;
    return <dl className={styles.prices} aria-label={`Resale comparisons · ${scope}`}>
        <div><dt>eBay sold median</dt><dd>{sold ? dollars(sold.price) : "No matched sales"}</dd>
            {sold && <dd className={styles.detail}>{sold.count} {sold.count === 1 ? "sale" : "sales"} · {sold.days} days · {scope}{sold.sellerCondition && " (seller-described)"}</dd>}</div>
        {tcg?.market != null && <div><dt>TCGplayer market</dt><dd>{dollars(tcg.market)}</dd><dd className={styles.detail}>{tcg.condition}</dd></div>}
        {tcg?.delivered != null && <div><dt>TCGplayer lowest offer</dt><dd>{dollars(tcg.delivered)}</dd><dd className={styles.detail}>{tcg.condition} · shipped</dd></div>}
        {!tcg && <div><dt>TCGplayer</dt><dd className={styles.detail}>{/\d/.test(scope) ? "Raw cards only" : "No matched quote"}</dd></div>}
    </dl>;
}
