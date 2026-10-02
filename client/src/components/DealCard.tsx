import type { CSSProperties } from "react";
import type { AnalysisState } from "../App";
import type { ListingSummary } from "../types";
import { dollars, timeLeft } from "../format";
import { ceilingLabel } from "../../../shared/format.ts";
import { offerFor, offerWorthMaking } from "../../../shared/money/offer.ts";
import { bargainScore, bargainSignals } from "../../../shared/signals.ts";
import { yearOf } from "../../../shared/sets.ts";
import { ChevronIcon } from "./Icons";
import { Tween } from "./Tween";
import styles from "./DealCard.module.css";

interface Props {
    // Place in the list, for the arrival stagger.
    index?: number;
    transitionName?: string;
    listing: ListingSummary;
    analysis?: AnalysisState;
    selected: boolean;
    now: number;
    onOpen: () => void;
    // Release years by set, for the subtitle.
    years: Record<string, number>;
}

// How Dig deeper found it, in a word or two.
const FOUND: Record<string, string> = {
    MISSPELLED: "Misspelled title",
    NUMBER_ONLY: "Number-only title",
    WRONG_CATEGORY: "Wrong category",
    PHOTO_SHOWS_IT: "Photo shows it",
};

// Feedback counts, short: 1,234 is 1.2K and 71,100 is 71K; under 1,000, exact.
const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 2 });

function feedbackCount(count: number): string {
    return count < 1000 ? count.toLocaleString() : COMPACT.format(count);
}

// Whole dollars, for the line under the price: $1,139.
function wholeDollars(value: number): string {
    return `$${Math.round(value).toLocaleString()}`;
}

// The number as printed on the card: 004/102 is 4/102.
function printedNumber(number: string | null | undefined): string | null {
    return number ? number.replace(/^0+(?=\d)/, "") : null;
}

// Money with its sign: +$68.40 or -$120.30.
function signed(value: number | null): string {
    if (value === null) return "";
    return value < 0 ? `\u2212${dollars(-value)}` : `+${dollars(value)}`;
}

export function DealCard({ listing, analysis, selected, now, onOpen, years, index = 0, transitionName }: Props) {
    const evaluation = analysis?.status === "done" ? analysis.evaluation : null;
    const underwriting = evaluation?.underwriting ?? null;
    const best = underwriting?.best ?? null;
    const rating = evaluation?.rating ?? null;
    const deal = underwriting?.verdict.startsWith("BUY") ?? false;
    const screen = listing.screen;
    const auction = listing.buyingOption === "AUCTION";
    const left = timeLeft(listing.endTime, now);
    const plan = offerFor(listing, best?.maxBid);
    // Doesn't clear at its asking price, but would at a realistic offer.
    const offer = underwriting?.verdict === "PASS" && offerWorthMaking(plan) ? plan : null;
    const longShot = rating?.level === "LONG_SHOT" || Boolean(screen?.longShot);

    // The verdict, in the palette's meanings.
    const [badge, tone] =
        analysis?.status === "loading"
            ? ["Analyzing", "pending"]
            : longShot
              ? ["Long shot", "quiet"]
              : deal
                ? rating?.level === "THIN"
                    ? ["Thin", "watch"]
                    : best?.path === "GRADE"
                      ? ["Buy + grade", "grade"]
                      : ["Buy", "buy"]
                : offer
                  ? ["Offer", "offer"]
                  : underwriting?.verdict === "NEEDS_REVIEW"
                    ? ["Review", "watch"]
                    : underwriting?.verdict === "CANT_PRICE"
                      ? ["Can't price", "watch"]
                      : underwriting?.verdict === "PASS"
                        ? ["Pass", "pass"]
                        : screen?.status === "CANDIDATE"
                          ? ["Possible", "pending"]
                          : screen?.status === "DROPPED"
                            ? ["Too pricey", "quiet"]
                            : ["Unverified", "quiet"];

    // The card itself, once identified; the eBay title until then.
    const card = evaluation?.identity ?? screen?.card ?? null;
    const name = card?.name ? [card.name, printedNumber(card.cardNumber)].filter(Boolean).join(" ") : listing.title;
    const subtitle = card?.name
        ? // Unlimited is the usual printing; 1st Edition and Shadowless are worth saying.
          [card.set, yearOf(years, card.set), card.printing === "UNLIMITED" ? null : card.printingLabel]
              .filter(Boolean)
              .join(" \u00b7 ")
        : listing.isGraded
          ? "Graded"
          : "Raw";

    // Profit at this price: for an auction, near its usual price or at the max bid.
    const profit =
        best && auction
            ? rating?.auction?.profitAtUsual != null
                ? { value: rating.auction.profitAtUsual, roi: null }
                : { value: best.profitAtMaxBid ?? null, roi: best.roiAtMaxBid ?? null }
            : best
              ? { value: best.profit ?? null, roi: best.roi ?? null }
              : null;
    const gain = (profit?.value ?? 0) >= 0;

    // Likely grade: the slab's own, or the AI's likely grade for a raw card.
    const range = evaluation?.condition?.gradeRange;
    const grader = best?.grader ?? "PSA";
    const grade = evaluation?.slab?.grade
        ? `${evaluation.slab.grader ?? ""} ${evaluation.slab.grade}`.trim()
        : range
          ? range.likely !== null
              ? `${grader} ${range.likely}`
              : `${grader} ${range.low}\u2013${range.high}`
          : "\u2014";

    // What it sells for on the path that pays best.
    const comp = best ? (best.path === "GRADE" ? best.expectedSale : best.salePrice) : null;

    const seller = listing.seller;
    // No feedback yet reads as new, not as a 0% rating.
    const sellerText =
        seller?.feedbackScore === 0
            ? "New seller"
            : seller?.feedbackPercentage != null
              ? `${seller.feedbackPercentage}% (${feedbackCount(seller.feedbackScore ?? 0)})`
              : "\u2014";

    // The line under the price: the most you'd pay, and how it's sold.
    const signals = bargainSignals(listing, evaluation, now);
    const ceiling = best?.maxBid ?? screen?.bestCase?.maxBid ?? null;
    const meta = [
        ceiling !== null
            ? `${ceilingLabel(listing.buyingOption)} ${wholeDollars(ceiling)}${best ? "" : " at best"}`
            : null,
        auction ? `${listing.bids} ${listing.bids === 1 ? "bid" : "bids"}` : "Buy It Now",
        auction ? left : null,
        listing.shipping === null ? "ship not quoted" : listing.shipping === 0 ? "free ship" : `${dollars(listing.shipping)} ship`,
    ].filter(Boolean);
    const metaShort = [meta[0], auction ? left : "Buy It Now"].filter(Boolean);

    return (
        <article
            className={`${styles.card} ${selected ? styles.selected : ""}`}
            data-tone={tone}
            // A short stagger as results arrive; a name to glide by when sorted.
            style={{ "--i": Math.min(index, 10), viewTransitionName: transitionName } as CSSProperties}
        >
            {/* The whole card opens the analysis. */}
            <button type="button" className={styles.hit} onClick={onOpen} aria-label={`Open ${name}`} />

            <div className={styles.photo}>
                {listing.images[0] && <img src={listing.images[0]} alt="" loading="lazy" />}
            </div>

            <div className={styles.body}>
                <div className={styles.head}>
                    <h2 className={styles.name}>{name}</h2>
                    <span className={styles.badge}>{badge}</span>
                </div>
                <p className={styles.set}>{subtitle}</p>

                <div className={styles.priceRow}>
                    <span className={styles.price}>
                        {dollars(listing.currentPrice)}
                        {auction && <small> bid</small>}
                    </span>
                    {profit?.value != null && (
                        <span className={gain ? styles.gain : styles.loss}>
                            <Tween value={profit.value} format={signed} />
                        </span>
                    )}
                    {profit?.roi != null && (
                        <span className={gain ? styles.gain : styles.loss}>{Math.round(profit.roi * 100)}% ROI</span>
                    )}
                </div>

                <p className={styles.meta}>
                    {listing.found && <span className={styles.found}>{FOUND[listing.found.how] ?? "Hidden find"}</span>}
                    {/* A narrow card keeps just the max price and time left. */}
                    <span className={styles.metaFull}>{meta.join(" \u00b7 ")}</span>
                    <span className={styles.metaShort}>{metaShort.join(" \u00b7 ")}</span>
                    {signals.length > 0 && tone !== "quiet" && (
                        <span className={styles.bargain} title={signals.map((signal) => signal.label).join(", ")}>
                            Bargain {bargainScore(signals)}
                        </span>
                    )}
                </p>
            </div>

            {/* Beside the photo on a wide card; full width under it on a narrow one. */}
            <dl className={styles.stats}>
                    <div>
                        <dt>Est. grade</dt>
                        <dd>{grade}</dd>
                    </div>
                    <div>
                        <dt>Comp value</dt>
                        <dd>{comp != null ? wholeDollars(comp) : "\u2014"}</dd>
                    </div>
                    <div>
                        <dt>Seller</dt>
                        <dd>{sellerText}</dd>
                    </div>
                    <ChevronIcon className={styles.chevron} />
                </dl>
        </article>
    );
}
