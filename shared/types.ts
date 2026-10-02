// The shapes the server builds and the page shows. One definition for
// both sides, so a renamed field fails the type check instead of
// quietly blanking a number on the page.

import type { RawCondition } from "./conditions.ts";

export type Printing = "FIRST_EDITION" | "SHADOWLESS" | "UNLIMITED";
export type Verdict = "BUY_RAW" | "BUY_AND_GRADE" | "BUY_GRADED" | "PASS" | "NEEDS_REVIEW" | "CANT_PRICE";
export type Confidence = "HIGH" | "MEDIUM" | "LOW" | "NONE";
export type BuyingOption = "AUCTION" | "FIXED_PRICE";
export type PriceStatus = "PRICED" | "PRICE_UNAVAILABLE";

// What a deal has to clear: profit after every cost, and return on
// everything you put in. You set these on the page.
export interface Targets {
    minProfit: number;
    minRoi: number;
}

// Graders whose sold comps the money math uses.
export type Grader = "PSA" | "CGC";

// ---- Listings ----

export interface Seller {
    username: string | null;
    feedbackPercentage: number | null;
    feedbackScore: number | null;
}

// The free check, before any AI: the listing at its best.
export interface Screen {
    status: "CANDIDATE" | "DROPPED" | "UNSCREENED";
    reason: string | null;
    card: {
        name: string | null;
        set: string | null;
        cardNumber: string | null;
        printing: Printing | "UNKNOWN";
        printingLabel: string | null;
    } | null;
    bestCase: { label: string; maxBid: number; profit: number; roi: number | null } | null;
    assumed: string | null;
    // The paths the free check priced, so its verdict can be redone for
    // other targets without another lookup.
    money?: {
        shipping: number;
        paths: { label: string; expectedNet: number; fixedCosts: number }[];
        auction: boolean;
        usual: UsualPrice | null;
    };
    // An auction that will very likely end above even its best-case max
    // bid. Not worth the AI.
    longShot?: boolean;
    // Priced far below anything the card sells for: a fake, a reprint, or
    // not the card at all. Skipped like other junk.
    junk?: boolean;
    // The check was missing the set, number, name, grader, or grade: the
    // listing's own item details might settle it.
    incomplete?: boolean;
    // Item details the AI read from the title because the seller left them out.
    filledFromTitle?: string[];
}

// Today's eBay Browse allowance, from eBay's own count.
export interface EbayUsage {
    used: number;
    limit: number;
    remaining: number;
    resetsAt: string | null;
    // In the last of the day's allowance: listings are checked from titles only.
    braking: boolean;
}

// What a search means: the card it's for, and anything it narrows to.
// Empty or null fields mean any.
export interface SearchIntent {
    cardName: string | null;
    sets: string[];
    cardNumber: string | null;
    printing: Printing | null;
    graded: boolean | null;
    // Words a title has to contain to be this card, like ["charizard"].
    titleWords: string[];
    // Read by the AI, or by plain rules when the AI isn't available.
    source: "ai" | "rules";
}

// One search result, with the free check once it's run.
export interface ListingSummary {
    id: string;
    title: string;
    currentPrice: number | null;
    shipping: number | null;
    bids: number;
    isGraded: boolean;
    buyingOption: BuyingOption;
    endTime: string | null;
    images: string[];
    url: string;
    seller: Seller | null;
    // A Buy It Now that takes Best Offers.
    bestOffer?: boolean;
    cardCondition?: string | null;
    conditionNotes?: string[];
    screen?: Screen;
    // Set when the free check shows it isn't the card searched for.
    match?: "OTHER_SET" | "OTHER_CARD" | "OTHER_PRINTING" | "OTHER_LANGUAGE" | "JUNK";
}

// ---- Photos and condition (the AI's findings, after the code rules) ----

export interface PhotoReport {
    number: number;
    view: string;
    usable: boolean;
    isStockImage: boolean;
    issues: string[];
}

export interface PhotoCheck {
    photoSufficiency: string;
    confidence: string;
    cardCount: string;
    holder: string;
    images: PhotoReport[];
    missingViews: string[];
    problems: string[];
    printedName?: string | null;
    printedNumber?: string | null;
    printingMarks?: PrintingMarks;
    // Whether the photographed card is the card the listing claims.
    cardMatch?: { verdict: "MATCH" | "MISMATCH" | "CANT_TELL"; problems: string[] };
    slab?: SlabReading | null;
}

export interface PrintingMarks {
    firstEditionStamp: string;
    artBoxShadow: string;
    // A reprint's or special printing's mark on the artwork, if any.
    reprintMark?: string;
    evidence?: string[];
}

// What the photos show of a graded case and its label.
export interface SlabReading {
    present: boolean;
    grader: string | null;
    grade: string | null;
    gradeQualifier: string | null;
    certNumber: string | null;
    labelText: string | null;
    caseCondition: string;
    authenticity: string;
    concerns: string[];
}


export interface AreaFinding {
    visibility: string;
    severity: string;
    observations: string[];
}

export interface GradeRange {
    low: number;
    likely: number | null;
    high: number;
}

export interface Authenticity {
    concern: "NONE_SEEN" | "POSSIBLE" | "LIKELY_FAKE";
    reasons: string[];
}

export interface Condition {
    centering: AreaFinding;
    corners: AreaFinding;
    edges: AreaFinding;
    surface: AreaFinding;
    creases: string;
    rawCondition: RawCondition | "UNKNOWN";
    gradeRange: GradeRange;
    authenticity: Authenticity;
    confidence: string;
    limitations: string[];
    summary: string;
}

export interface SetAsideAnswer {
    gradeRange: GradeRange;
    rawCondition: string;
    authenticity: string;
}

// ---- Identity ----

export interface Identity {
    status: "IDENTIFIED" | "NEEDS_REVIEW";
    name: string | null;
    set: string | null;
    cardNumber: string | null;
    printing: Printing | "UNKNOWN";
    printingLabel: string | null;
    finish: string;
    language: string;
    // Why the photos show this isn't the card the listing claims: a
    // reprint's mark, another set's symbol, a fake. Set aside on the page.
    notThisCard?: string | null;
    evidence: {
        title: string;
        itemSpecifics: string;
        label?: string;
        photo: string;
        photoSource?: string;
        photoNotes: string[];
    } | null;
    reasons: string[];
}

// ---- Prices ----

export interface RawPrice {
    condition: RawCondition | "UNKNOWN";
    price: number;
    updatedAt: string | null;
}

// Where a price came from and which database printing it is.
interface PriceSource {
    source?: string;
    printing?: Printing | "UNKNOWN";
    variant?: string;
}

export interface RawPricing extends PriceSource {
    status: PriceStatus;
    reason?: string;
    printingLabel?: string;
    finish?: string;
    prices?: RawPrice[];
}

export interface CompSale {
    price: number;
    soldAt: string;
    title: string;
    url: string | null;
}

export interface CompSummary {
    grader: string;
    grade: number | string;
    count: number;
    median: number | null;
    low: number | null;
    high: number | null;
    newestSale: string | null;
    confidence: Confidence;
    dropped: Record<string, number>;
    sales: CompSale[];
    // The AI checked the sales that passed the rules.
    checkedByAI?: boolean;
}

export interface GradedPricing extends PriceSource {
    status: PriceStatus;
    reason?: string;
    printingLabel?: string;
    grader?: string;
    byGrade?: CompSummary[];
}

export interface Slab {
    status: "OK" | "NEEDS_REVIEW" | "LIKELY_FAKE";
    grader: string | null;
    grade: string | null;
    gradeQualifier: string | null;
    certNumber: string | null;
    certUrl: string | null;
    labelText: string | null;
    caseCondition: string;
    reasons: string[];
    concerns: string[];
}

export interface SlabPricing extends PriceSource {
    status: PriceStatus;
    reason?: string;
    printingLabel?: string;
    grader?: string;
    grade?: number | string;
    summary?: CompSummary;
}

// ---- Money ----

export interface GradeOutlook {
    grade: number;
    probability: number;
    price: number;
    filledFrom: number | null;
    net: number;
}

export type PathKind = "RAW" | "GRADE" | "GRADED_RESALE";

export interface UnavailablePath {
    path: PathKind;
    label: string;
    status: "UNAVAILABLE";
    reason: string;
    grader?: Grader;
}

export interface PricedPath {
    path: PathKind;
    label: string;
    status: "PRICED";
    // What you keep from the sale, on average, after fees and shipping.
    expectedNet: number;
    // Grading fee and grading shipping; zero for a raw or slab resale.
    fixedCosts: number;
    // What buying it costs to ship to you.
    shipping: number;
    // Everything you put in at the current price.
    cost: number;
    profit: number;
    roi: number | null;
    // Profit if it sells at the low end.
    downside: number;
    // The most you can pay and still clear your targets.
    maxBid: number;
    clears: boolean;
    // What you'd make paying the max bid: the number that matters for
    // an auction, whose current bid will rise.
    profitAtMaxBid: number | null;
    roiAtMaxBid: number | null;
    grader?: Grader;
    salePrice?: number;
    priceCondition?: RawCondition;
    tier?: string;
    gradingFee?: number;
    expectedSale?: number;
    outlook?: GradeOutlook[];
}

export type MoneyPath = UnavailablePath | PricedPath;

export interface Underwriting {
    verdict: Verdict;
    reasons: string[];
    best: PricedPath | null;
    paths: MoneyPath[];
    assumptions: string[];
}

// What a listing usually sells for, as listed, and the recent sales
// behind it when there's a list.
export interface UsualPrice {
    price: number;
    sales?: number[];
}

// How likely an auction is to end at or under the max bid.
export interface AuctionOutlook {
    chance: "LIKELY" | "POSSIBLE" | "LONG_SHOT";
    usualPrice: number;
    salesAtOrUnder: number | null;
    salesTotal: number | null;
}

// LONG_SHOT: an auction that will very likely end above the max bid.
export type RatingLevel = "STRONG" | "GOOD" | "THIN" | "LONG_SHOT";

export interface Rating {
    level: RatingLevel;
    // How far the price sits under the max bid, for fixed-price listings.
    room: number | null;
    strengths: string[];
    concerns: string[];
    notes: string[];
    // For an auction: how likely it is to end at or under the max bid.
    auction?: AuctionOutlook | null;
}

// ---- One analyzed listing ----

export interface Evaluation {
    listing: {
        id: string;
        title: string;
        url: string;
        price: number | null;
        shipping: number | null;
        buyingOption: BuyingOption;
        bids: number;
        endTime: string | null;
        photosInListing: number;
        photosAnalyzed: number;
        cardCondition: string | null;
        conditionNotes: string[];
        seller: Seller | null;
        // eBay's condition ("Ungraded", "Graded") and the item specifics.
        sellerCondition: string | null;
        aspects: Record<string, string>;
    };
    photoCheck: PhotoCheck | null;
    gradingMode: "FULL" | "LIMITED" | "BLOCKED";
    modeReasons: string[];
    gradeStatus: string;
    condition: Condition | null;
    setAside: SetAsideAnswer[];
    identity: Identity | null;
    rawPricing: RawPricing | null;
    gradedPricing: Partial<Record<Grader, GradedPricing>> | null;
    slab: Slab | null;
    slabPricing: SlabPricing | null;
    underwriting: Underwriting | null;
    rating: Rating | null;
    answeredAt: string | null;
    reusedSteps: string[];
    usage: { step: string; inputTokens: number | null; outputTokens: number | null }[];
}
