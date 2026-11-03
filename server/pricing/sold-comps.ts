import {
    mapVariantPrintings,
    printingClaimFromText,
    lookAlikeProblem,
    noveltyIn,
    titleDecidesPrinting,
    finishOfVariant,
    type PrintingClaim,
} from "../identity/card-identity.ts";
import { gradeQualifier } from "../../shared/grade-qualifier.ts";
import type { CompSummary, Confidence } from "../../shared/types.ts";
import type { Comp, CompDropReason, CompVerdict, PrintingOrUnknown } from "./types.ts";

// Shared evidence rules for raw and graded sold comparables. These functions
// filter and summarize supplied sales without fetching prices or photos.

// How an AI-dropped sale is counted with the rest of the dropped sales.
const AI_DROP_NAMES: Record<CompDropReason, string> = {
    ANOTHER_CARD: "another card or product",
    ANOTHER_PRINTING: "another printing",
    ANOTHER_GRADE: "another grade or grader",
    QUALIFIED_OR_SPECIAL: "a qualifier or special label",
    NOT_ONE_CARD: "not a single card",
    SIGNED_OR_ALTERED: "signed or altered",
    ERROR_OR_VARIANT: "an error or print variant",
    OTHER: "another reason",
};

export interface CompCriteria {
    printing: PrintingOrUnknown;
    setName: string | null | undefined;
    grader: string;
    grade: number | string;
    now: number;
    windowDays?: 90 | 180;
    finish?: string;
}

// Only recent sales price a card.
const RECENT_DAYS = 180;
const DAY_MS = 86400000;

// A sale this far from the others' median is more likely a mislabeled
// printing or a special copy than a price. Needs 3 or more sales.
const OUTLIER_FACTOR = 2.5;
const CONFIRMED_SALE_TYPES = ["auction", "fixed_price", "best_offer_accepted"];

// PSA qualifiers (off-center, miscut, stain...) sell below a plain grade.
const PSA_QUALIFIER = /\((oc|mk|mc|st|pd|of)\)/i;

function titleAgrees(claim: PrintingClaim, printing: PrintingOrUnknown): boolean {
    if (claim === "CONFLICTING") return false;
    if (printing === "FIRST_EDITION") return claim === "FIRST_EDITION";
    if (printing === "SHADOWLESS") return claim === "SHADOWLESS";

    return claim === "NOT_STATED" || claim === "UNLIMITED";
}

// Why a comp's printing doesn't match, or null when it does.
export function printingProblem(comp: Comp, printing: PrintingOrUnknown, setName: string | null | undefined): string | null {
    const claim = printingClaimFromText(comp.title);

    // Where the labels are known to be wrong, the title decides:
    // "1st Edition Shadowless" versus "Shadowless without 1st Edition".
    // A title that says neither can't be placed.
    if (titleDecidesPrinting(setName)) {
        if (claim !== "FIRST_EDITION" && claim !== "SHADOWLESS") {
            return "title doesn't say which Shadowless printing";
        }

        return claim === printing ? null : "title names another printing";
    }

    // Everywhere else the label and the title both have to agree.
    const label = comp.variant ? mapVariantPrintings([comp.variant], setName)[comp.variant] : null;

    if (label !== printing) return "labeled as another printing";
    if (!titleAgrees(claim, printing)) return "title names another printing";

    return null;
}

// Why a comp can't price this card, or null when it can.
export function compProblem(comp: Comp, { printing, setName, grader, grade, now, windowDays = RECENT_DAYS, finish }: CompCriteria): string | null {
    if (comp.attribution !== "exact") return "shared with another card";
    if (comp.currency && comp.currency !== "USD") return "not a USD sale";

    const mismatch = printingProblem(comp, printing, setName);

    if (mismatch) return mismatch;
    if (finish && ["HOLO", "NON_HOLO", "REVERSE_HOLO"].includes(finish) && finishOfVariant(comp.variant ?? "") !== finish) return "another finish";
    if (lookAlikeProblem(comp.title, setName)) return "title names another product";
    if (noveltyIn(comp.title)) return "metal or novelty card";
    if (comp.grader !== grader || comp.grade !== String(grade)) return "different grade";
    if (gradeQualifier(comp.grade_qualifier, comp.grader, comp.grade) || PSA_QUALIFIER.test(comp.title ?? "")) return "qualified or special grade";
    // Older provider rows can retain an asking price when the final sale type
    // is unknown. Only confirmed transaction amounts may form resale prices;
    // a real accepted-offer amount is still usable when explicitly identified.
    if (!CONFIRMED_SALE_TYPES.includes(comp.sale_type ?? "")) return "sale amount not confirmed";
    if (!(typeof comp.price === "number" && Number.isFinite(comp.price) && comp.price > 0)) return "no sale price";

    const ageDays = (now - Date.parse(comp.sold_at)) / DAY_MS;

    if (!Number.isFinite(ageDays)) return "invalid sale date";
    if (ageDays < 0) return "future sale date";
    if (!(ageDays <= windowDays)) return `older than ${windowDays} days`;

    return null;
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function confidenceFor(count: number): Confidence {
    if (count >= 5) return "HIGH";
    if (count >= 3) return "MEDIUM";
    if (count >= 1) return "LOW";

    return "NONE";
}

// The verified sales for one grade, and what was dropped and why. Sales
// pass the rules first; verdicts, when given, are the AI's second look.
export function summarizeComps(
    comps: Comp[],
    criteria: CompCriteria,
    verdicts?: Map<Comp, CompVerdict>
): CompSummary {
    let kept: Comp[] = [];
    const dropped: Record<string, number> = {};
    const drop = (reason: string) => {
        dropped[reason] = (dropped[reason] ?? 0) + 1;
    };

    for (const comp of comps) {
        const verdict = verdicts?.get(comp);
        const problem =
            compProblem(comp, criteria) ??
            (verdict && !verdict.keep ? `AI: ${AI_DROP_NAMES[verdict.reason ?? "OTHER"]}` : null);

        if (problem) {
            drop(problem);
        } else {
            kept.push(comp);
        }
    }

    if (kept.length >= 3) {
        const middle = median(kept.map((comp) => comp.price));

        kept = kept.filter((comp) => {
            const far = comp.price > middle * OUTLIER_FACTOR || comp.price < middle / OUTLIER_FACTOR;

            if (far) drop("price far from the other sales");

            return !far;
        });
    }

    const prices = kept.map((comp) => comp.price).sort((a, b) => a - b);

    return {
        grader: criteria.grader,
        grade: criteria.grade,
        count: kept.length,
        median: prices.length > 0 ? median(prices) : null,
        mean: prices.length > 0 ? Math.round(prices.reduce((sum, price) => sum + price, 0) / prices.length * 100) / 100 : null,
        low: prices[0] ?? null,
        high: prices.at(-1) ?? null,
        newestSale: kept.map((comp) => comp.sold_at).sort().at(-1) ?? null,
        confidence: confidenceFor(kept.length),
        dropped,
        sales: kept.map((comp) => ({
            ...(comp.photoCondition ? { photoCondition: comp.photoCondition, sellerCondition: comp.sellerCondition } : {}),
            price: comp.price,
            soldAt: comp.sold_at,
            title: comp.title,
            url: comp.listing_url ?? null,
        })),
        windowDays: criteria.windowDays ?? RECENT_DAYS,
        ...(kept.length > 0 && kept.every((comp) => verdicts?.has(comp)) ? { checkedByAI: true } : {}),
    };
}
