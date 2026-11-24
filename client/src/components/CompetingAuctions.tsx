import { useMemo } from "react";
import type { ListingSummary, SearchIntent, Targets } from "../types";
import type { AnalysisState } from "../analysis-state";
import { dollars } from "../format";
import { COMPETING_AUCTION_MINUTES, competingAuctions } from "../search/competing-auctions";
import styles from "./CompetingAuctions.module.css";

export function CompetingAuctions({ listings, analyses, intent, targets, now, onOpen }: {
    listings: ListingSummary[]; analyses: Record<string, AnalysisState>; intent?: SearchIntent | null;
    targets: Targets; now: number; onOpen: (id: string) => void;
}) {
    const groups = useMemo(() => competingAuctions(listings, analyses, intent, targets, now), [listings, analyses, intent, targets, now]);
    if (!groups.length) return null;
    return <section className={styles.panel} aria-label="Competing auctions">
        <h2>Competing auctions</h2>
        <p>Each group of matching slabs closes within a {COMPETING_AUCTION_MINUTES}-minute window. Bid totals include quoted shipping and estimated tax.</p>
        {groups.map(group => <div key={group.rows[0].listing.id} className={styles.group}>
            <h3>{group.label}</h3>
            {group.rows.map(row => <div className={styles.row} key={row.listing.id}>
                <div><button type="button" onClick={() => onOpen(row.listing.id)}>{row.listing.title}</button>
                    <small>Ends <time dateTime={row.listing.endTime!}>{new Date(row.ends).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}</time></small></div>
                <div><strong>{row.nextTotal === null ? "Next total unconfirmed" : dollars(row.nextTotal) + " at next bid"}</strong>
                    <small>{row.ceiling === null ? "Item-bid limit unavailable" : dollars(row.ceiling) + " item-bid limit"}</small></div>
                <span className={row.listing.id === group.preferredId ? styles.within : undefined}>{row.listing.id === group.preferredId ? "Lowest next bid within limit" :
                    row.status === "WITHIN" ? "Within limit" : row.status === "PASS" ? "Pass at next bid" : "Check bid and terms"}</span>
            </div>)}
            <p>{group.bin ? <button type="button" onClick={() => onOpen(group.bin!.listing.id)}>Compare Buy It Now at {dollars(group.bin.total)} total</button> :
                "No verified Buy It Now comparison in these results."}</p>
        </div>)}
    </section>;
}
