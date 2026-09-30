import {
    mapVariantPrintings,
    printingClaimFromText,
    printingLabel,
    readyForPricing,
    titleDecidesPrinting,
} from "./card-identity.js";
import { canPrice, variantFor } from "./pricing.js";

// Only recent sales price a card.
const RECENT_DAYS = 180;
const DAY_MS = 86400000;

// A sale this far from the others' median is more likely a mislabeled
// printing or a special copy than a price. Needs 3 or more sales.
const OUTLIER_FACTOR = 2.5;

// PSA qualifiers (off-center, miscut, stain...) sell below a plain grade.
const PSA_QUALIFIER = /\((oc|mk|mc|st|pd|of)\)/i;

function titleAgrees(claim, printing) {
    if (claim === "CONFLICTING") return false;
    if (printing === "FIRST_EDITION") return claim === "FIRST_EDITION";
    if (printing === "SHADOWLESS") return claim === "SHADOWLESS";

    return claim === "NOT_STATED" || claim === "UNLIMITED";
}

// Why a comp's printing doesn't match, or null when it does.
function printingProblem(comp, printing, setName) {
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
export function compProblem(comp, { printing, setName, grader, grade, now }) {
    if (comp.attribution !== "exact") return "shared with another card";

    const mismatch = printingProblem(comp, printing, setName);

    if (mismatch) return mismatch;
    if (comp.grader !== grader || comp.grade !== String(grade)) return "different grade";
    if (comp.grade_qualifier || PSA_QUALIFIER.test(comp.title ?? "")) return "qualified or special grade";
    if (!(typeof comp.price === "number" && comp.price > 0)) return "no sale price";

    const ageDays = (now - Date.parse(comp.sold_at)) / DAY_MS;

    if (!(ageDays <= RECENT_DAYS)) return "older than 180 days";

    return null;
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function confidenceFor(count) {
    if (count >= 5) return "HIGH";
    if (count >= 3) return "MEDIUM";
    if (count >= 1) return "LOW";

    return "NONE";
}

// The verified sales for one grade, and what was dropped and why.
export function summarizeComps(comps, criteria) {
    let kept = [];
    const dropped = {};
    const drop = (reason) => {
        dropped[reason] = (dropped[reason] ?? 0) + 1;
    };

    for (const comp of comps) {
        const problem = compProblem(comp, criteria);

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
        low: prices[0] ?? null,
        high: prices.at(-1) ?? null,
        newestSale: kept.map((comp) => comp.sold_at).sort().at(-1) ?? null,
        confidence: confidenceFor(kept.length),
        dropped,
        sales: kept.map((comp) => ({
            price: comp.price,
            soldAt: comp.sold_at,
            title: comp.title,
            url: comp.listing_url ?? null,
        })),
    };
}

function unavailable(reason, extra = {}) {
    return { status: "PRICE_UNAVAILABLE", reason, ...extra };
}

// Verified sold comps for each grade in the estimated range.
export async function gradedPricesFor(
    card,
    identity,
    gradeRange,
    { fetchComps, grader = "PSA", now = Date.now() }
) {
    if (!readyForPricing(identity)) {
        return unavailable("The card isn't fully identified, so graded copies can't be priced.");
    }
    if (!gradeRange) {
        return unavailable("There's no grade estimate to price.");
    }
    if (!canPrice(`${card?.source}Comps`, ["printing", "grade"])) {
        return unavailable("This price source can't price graded copies by printing.");
    }

    const { variant, reason } = variantFor(card, identity);

    if (!variant) return unavailable(reason);

    const label = printingLabel(identity.printing, identity.set);

    // Where the title decides, sales filed under every label of this
    // record are read; otherwise only this printing's own label.
    const sourceLabels = titleDecidesPrinting(variant.setName)
        ? card.variants.filter((v) => v.recordId === variant.recordId).map((v) => v.name)
        : [variant.name];

    const byGrade = [];

    for (let grade = gradeRange.low; grade <= gradeRange.high; grade += 1) {
        const comps = [];
        const seen = new Set();

        for (const sourceLabel of sourceLabels) {
            for (const comp of await fetchComps(variant.recordId, { grader, grade, variant: sourceLabel })) {
                const key = comp.id ?? comp.listing_url ?? `${comp.title}|${comp.sold_at}|${comp.price}`;

                if (!seen.has(key)) {
                    seen.add(key);
                    comps.push(comp);
                }
            }
        }

        byGrade.push(
            summarizeComps(comps, {
                printing: identity.printing,
                setName: variant.setName,
                grader,
                grade,
                now,
            })
        );
    }

    const details = { printingLabel: label, variant: variant.name, grader, byGrade };

    if (!byGrade.some((summary) => summary.count > 0)) {
        return unavailable(
            `No verified ${grader} sales of the ${label} printing in grades ${gradeRange.low} to ${gradeRange.high}.`,
            details
        );
    }

    return {
        status: "PRICED",
        source: card.source,
        printing: variant.printing,
        ...details,
    };
}
