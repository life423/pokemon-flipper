import type { AuctionOpportunity } from "../../../shared/auction-opportunity.ts";
import type { ListingSummary } from "../../../shared/types.ts";
import { dollars, timeLeft } from "../format";
import styles from "./CompetingAuctions.module.css";

interface Props {
    listings: ListingSummary[];
    decisions: Record<string, { auctionOpportunity?: AuctionOpportunity }>;
    now: number;
    onOpen: (id: string, opener: HTMLElement) => void;
}

const rank = { BID: 0, WATCH: 1, PASS: 2 };
export function AuctionOpportunities({ listings, decisions, now, onOpen }: Props) {
    const matches = listings.flatMap(listing => {
        const opportunity = decisions[listing.id]?.auctionOpportunity;
        return opportunity && now < opportunity.validUntil ? [{ listing, opportunity }] : [];
    }).sort((a, b) => rank[a.opportunity.status] - rank[b.opportunity.status] ||
        Date.parse(a.opportunity.endsAt) - Date.parse(b.opportunity.endsAt));
    if (!matches.length) return null;
    return <section className={styles.panel} aria-label="Auction opportunities">
        <h2>Auction opportunities</h2>
        <p>Ending in under 10 hours with a current price below matching sales.</p>
        {matches.map(({ listing, opportunity: o }) => <article key={listing.id} className={styles.group}>
            <h3><button onClick={event => onOpen(listing.id, event.currentTarget)}>{listing.title}</button></h3>
            <div className={styles.row}>
                <div><strong>{dollars(o.currentPrice)} {listing.bids === 0 ? "opening price" : "current bid"}</strong>
                    <small><time dateTime={o.endsAt}>{timeLeft(o.endsAt, now)} left</time></small></div>
                <div><strong>{dollars(o.marketValue)} {o.marketLabel}</strong>
                    <small>{o.sales30} matching {o.sales30 === 1 ? "sale" : "sales"} in the past 30 days</small></div>
                {o.nextBid !== null && <div><strong>{dollars(o.nextBid)} next bid</strong>
                    {o.nextTotal !== null && <small>{dollars(o.nextTotal)} with shipping and estimated tax</small>}</div>}
            </div>
            <p>{o.reason}</p>
            {o.grading && <p>{o.grading.grader} grading and submission shipping add {dollars(o.grading.gradingCosts)}. If you win at the next bid,
                estimated profit is {dollars(o.grading.likelyProfit)} at grade {o.grading.likelyGrade} and {dollars(o.grading.lowerProfit)} at grade {o.grading.lowerGrade}.</p>}
        </article>)}
    </section>;
}
