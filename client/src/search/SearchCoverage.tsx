import type { SearchSourceCoverage, SourceDispositionRow } from "../../../shared/search-diagnostic.ts";
import { parseListingLink } from "../../../shared/listing-link.ts";
import { describeListingBlock } from "./analysis-admission";
import styles from "../App.module.css";

function dispositionReason(reason: SourceDispositionRow["reason"]): string {
    switch (reason) {
        case "VARIATION": return "Listing offers multiple variations";
        case "LOT": return "Listing contains multiple cards";
        case "DIGITAL": return "Digital card";
        case "PROXY_OR_REPLICA": return "Proxy or replica";
        case "MYSTERY": return "Mystery item";
        case "SEALED": return "Sealed product";
        case "MERCHANDISE": return "Merchandise or card accessory";
        case "EMPTY_HOLDER": return "Empty card holder";
        case "OUTSIDE_GRADING_WATCH": return "Listing date falls outside the last 24 hours or is unavailable";
        case "ALREADY_SEEN": return "Already seen in an earlier scan";
        case "ABOVE_SOLD_CEILING": return "Asking above the purchase limit set by recent sales";
        case "OTHER_CARD": return "Listing did not match the requested card or collector number";
        case "OTHER_SET": return "Different set";
        case "OTHER_PRINTING": return "Different printing";
        case "OTHER_GRADER": return "Different grading company";
        case "OTHER_GRADE": return "Outside the requested grade range";
        case "OTHER_FINISH": return "Different finish";
        case "SOLD_PRICE_EXCLUDED": return "Recent matched sales did not support the asking price at your targets";
        case "ENOUGH_CANDIDATES": return "Screening stopped after finding enough candidates";
        default: return describeListingBlock(null, reason).label;
    }
}

function CoverageRows({ label, rows }: { label: string; rows: readonly { id: string; reason: string }[] }) {
    if (!rows.length) return <p>{label} (0)</p>;
    return <details className={styles.coverageGroup}>
        <summary>{label} ({rows.length.toLocaleString()})</summary>
        <ul>{rows.map(({ id, reason }) => {
            const listing = parseListingLink(id);
            return <li key={id}>
                {listing ? <a href={listing.url} target="_blank" rel="noopener noreferrer">eBay listing {id}</a> : <strong>Listing {id}</strong>}
                <span>{reason}</span>
            </li>;
        })}</ul>
    </details>;
}

export function SearchCoverage({ report, finished }: {
    report: SearchSourceCoverage | null;
    finished: boolean;
}) {
    const { sourceCoverage: coverage, sourceDispositions: rows, overflow } = report ?? {};
    if (!coverage && !rows && !overflow && !finished) return null;
    const rejected = rows?.filter(row => row.outcome === "REJECTED") ?? [];
    const notReached = rows?.filter(row => row.outcome === "NOT_REACHED") ?? [];
    const screened = overflow?.rows ?? [];
    const hasCoverage = coverage !== undefined || rows !== undefined;

    return <details className={styles.skippedListings}>
        <summary>Listing coverage{hasCoverage && ` · ${rejected.length.toLocaleString()} rejected · ${notReached.length.toLocaleString()} not reached`}</summary>
        <div className={styles.coverageBody}>
            <p>These decisions cover the eBay listings fetched in this search window. Listings outside the fetched window have no individual status here.</p>
            {coverage === "PARTIAL" && <p>Coverage is partial. Some fetched listings have no recorded outcome.</p>}
            {!hasCoverage && <p>This search has no recorded rejection or not-reached details.</p>}
            {hasCoverage && <>
                <CoverageRows label="Rejected" rows={rejected.map(({ id, reason }) => ({ id, reason: dispositionReason(reason) }))} />
                <CoverageRows label="Not reached" rows={notReached.map(({ id, reason }) => ({ id, reason: dispositionReason(reason) }))} />
            </>}
            {!!screened.length && <CoverageRows label="Screened, outside display limit" rows={screened.map(({ id, reason }) => ({ id,
                reason: reason === "DISPLAY_LIMIT" ? "Eligible for assessment but outside the results limit" : describeListingBlock(null, reason).label,
            }))} />}
        </div>
    </details>;
}
