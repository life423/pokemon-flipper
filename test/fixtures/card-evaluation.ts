import { underwrite } from "../../shared/money/underwriting.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import type { CompSummary, Evaluation, Targets } from "../../shared/types.ts";

export function salesSummary(grader = "PSA", grade: number | string = 7, prices = [180, 200, 220]): CompSummary {
    return { grader, grade, count: prices.length, median: prices[1], low: Math.min(...prices), high: Math.max(...prices), newestSale: new Date().toISOString(), confidence: "HIGH", dropped: {},
        sales: prices.map((price, i) => ({ price, soldAt: new Date(Date.now() - (i + 1) * 86400000).toISOString(), title: `Offline ${grader} ${grade} comparable`, url: null })) };
}

export function cardEvaluation(targets: Targets = MONEY_CONFIG.targets): Evaluation {
    const area = () => ({ visibility: "CLEAR", severity: "MINOR", observations: ["Minor edge wear visible in offline fixture."] });
    const evaluation: Evaluation = {
        listing: { id: "offline-auction", title: "Venusaur Base Set 15/102 Holo — offline example", url: "#", price: 36.6, shipping: null, buyingOption: "AUCTION", bids: 1, endTime: new Date(Date.now() + 2 * 86400000).toISOString(), photosInListing: 4, photosAnalyzed: 4, cardCondition: "Near Mint", conditionNotes: [], sellerCondition: "Ungraded", aspects: {}, seller: { username: "offline-seller", feedbackPercentage: 100, feedbackScore: 22 } },
        identity: { status: "IDENTIFIED", name: "Venusaur", set: "Base Set", cardNumber: "015/102", printing: "UNLIMITED", printingLabel: "Unlimited", finish: "HOLO", language: "English", evidence: null, reasons: [] },
        photoCheck: { confidence: "HIGH", photoSufficiency: "SUFFICIENT", cardCount: "SINGLE", holder: "NONE", images: ["FRONT", "BACK", "FRONT_DETAIL", "BACK_DETAIL"].map((view, i) => ({ number: i + 1, view, usable: true, isStockImage: false, issues: [] })), missingViews: [], problems: [] },
        condition: { centering: area(), corners: area(), edges: area(), surface: area(), creases: "NONE_SEEN", rawCondition: "LIGHTLY_PLAYED", gradeRange: { low: 6, likely: 7, high: 8 }, authenticity: { concern: "NONE_SEEN", reasons: [] }, confidence: "HIGH", limitations: [], summary: "Offline photo assessment, not a real appraisal." },
        gradingMode: "FULL", modeReasons: [], gradeStatus: "ASSESSED", setAside: [],
        rawPricing: { status: "PRICED", prices: [{ condition: "LIGHTLY_PLAYED", price: 85, updatedAt: new Date().toISOString() }] },
        gradedPricing: { PSA: { status: "PRICED", byGrade: [6, 7, 8].map((g) => salesSummary("PSA", g, [g * 28 - 10, g * 28, g * 28 + 10])) }, CGC: { status: "PRICED", byGrade: [6, 7, 8].map((g) => salesSummary("CGC", g, [g * 20 - 10, g * 20, g * 20 + 10])) } },
        slab: null, slabPricing: null, underwriting: null, rating: null, answeredAt: new Date().toISOString(), reusedSteps: [], usage: [],
    };
    evaluation.underwriting = underwrite(evaluation, { ...MONEY_CONFIG, targets });
    return evaluation;
}
