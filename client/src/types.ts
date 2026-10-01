// What the server sends. These mirror the objects built in ebay.js,
// grading.js, and underwriting.js; when the backend moves to
// TypeScript, it uses these same types.

export type Printing = "FIRST_EDITION" | "SHADOWLESS" | "UNLIMITED" | "UNKNOWN";

export type Verdict =
    | "BUY_RAW"
    | "BUY_AND_GRADE"
    | "BUY_GRADED"
    | "PASS"
    | "NEEDS_REVIEW"
    | "CANT_PRICE";

export type Confidence = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export interface Seller {
    username: string | null;
    feedbackPercentage: number | null;
    feedbackScore: number | null;
}

// The free check, before any AI: the listing at its best.
export interface Screen {
    status: "CANDIDATE" | "DROPPED" | "UNSCREENED";
    reason: string | null;
    card: { name: string | null; set: string | null; cardNumber: string | null; printingLabel: string | null } | null;
    bestCase: { label: string; maxBid: number; profit: number; roi: number | null } | null;
    assumed: string | null;
}

export interface ListingSummary {
    id: string;
    title: string;
    currentPrice: number | null;
    shipping: number | null;
    bids: number;
    isGraded: boolean;
    buyingOption: "AUCTION" | "FIXED_PRICE";
    endTime: string | null;
    images: string[];
    url: string;
    seller: Seller | null;
    cardCondition?: string | null;
    conditionNotes?: string[];
    screen?: Screen;
}

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

export interface Condition {
    centering: AreaFinding;
    corners: AreaFinding;
    edges: AreaFinding;
    surface: AreaFinding;
    creases: string;
    rawCondition: string;
    gradeRange: GradeRange;
    authenticity: { concern: string; reasons: string[] };
    confidence: string;
    limitations: string[];
    summary: string;
}

export interface SetAsideAnswer {
    gradeRange: GradeRange;
    rawCondition: string;
    authenticity: string;
}

export interface Identity {
    status: "IDENTIFIED" | "NEEDS_REVIEW";
    name: string | null;
    set: string | null;
    cardNumber: string | null;
    printing: Printing;
    printingLabel: string | null;
    finish: string;
    language: string;
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

export interface RawPrice {
    condition: string;
    price: number;
    updatedAt: string | null;
}

export interface RawPricing {
    status: "PRICED" | "PRICE_UNAVAILABLE";
    reason?: string;
    printingLabel?: string;
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
}

export interface GradedPricing {
    status: "PRICED" | "PRICE_UNAVAILABLE";
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

export interface SlabPricing {
    status: "PRICED" | "PRICE_UNAVAILABLE";
    reason?: string;
    printingLabel?: string;
    summary?: CompSummary;
}

export interface GradeOutlook {
    grade: number;
    probability: number;
    price: number;
    filledFrom: number | null;
    net: number;
}

export interface MoneyPath {
    path: "RAW" | "GRADE" | "GRADED_RESALE";
    label: string;
    status: "PRICED" | "UNAVAILABLE";
    reason?: string;
    expectedNet?: number;
    cost?: number;
    profit?: number;
    roi?: number | null;
    downside?: number;
    maxBid?: number;
    clears?: boolean;
    salePrice?: number;
    priceCondition?: string;
    grader?: string;
    tier?: string;
    gradingFee?: number;
    expectedSale?: number;
    outlook?: GradeOutlook[];
}

export interface Underwriting {
    verdict: Verdict;
    reasons: string[];
    best: MoneyPath | null;
    paths: MoneyPath[];
    assumptions: string[];
}

export type RatingLevel = "STRONG" | "GOOD" | "THIN";

export interface Rating {
    level: RatingLevel;
    room: number;
    strengths: string[];
    concerns: string[];
    notes: string[];
}

export interface Evaluation {
    listing: {
        id: string;
        title: string;
        url: string;
        price: number | null;
        shipping: number | null;
        buyingOption: "AUCTION" | "FIXED_PRICE";
        bids: number;
        endTime: string | null;
        photosInListing: number;
        photosAnalyzed: number;
        cardCondition: string | null;
        conditionNotes: string[];
        seller: Seller | null;
    };
    photoCheck: PhotoCheck | null;
    gradingMode: "FULL" | "LIMITED" | "BLOCKED";
    modeReasons: string[];
    gradeStatus: string;
    condition: Condition | null;
    setAside: SetAsideAnswer[];
    identity: Identity | null;
    rawPricing: RawPricing | null;
    gradedPricing: Record<string, GradedPricing> | null;
    slab: Slab | null;
    slabPricing: SlabPricing | null;
    underwriting: Underwriting | null;
    rating: Rating | null;
    answeredAt: string | null;
    reusedSteps: string[];
    usage: { step: string; inputTokens: number | null; outputTokens: number | null }[];
}
