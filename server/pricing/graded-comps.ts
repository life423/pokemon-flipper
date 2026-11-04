import { printingLabel, readyForPricing, titleDecidesPrinting } from "../identity/card-identity.ts";
import { canPrice, variantFor } from "./raw-prices.ts";
import { compProblem, matchesSoldTarget, summarizeComps, type CompCriteria } from "./sold-comps.ts";
import type { CompSummary, GradeRange, GradedPricing, Identity, SlabPricing } from "../../shared/types.ts";
import type { CheckComps, Comp, CompTarget, FetchComps, PricedCard, PricedVariant } from "./types.ts";

// Retain the public evidence helpers for existing callers and tests.
export { compProblem, printingProblem, summarizeComps } from "./sold-comps.ts";
export type { CompCriteria } from "./sold-comps.ts";

const DAY_MS = 86400000;

function matchesTarget(comp: Comp, target: CompTarget): boolean {
    return matchesSoldTarget(comp, { name: target.cardName, setName: target.setName, cardNumber: target.cardNumber }, target.grader, target.grade);
}

// The rules, then the AI's second look at whatever passed them.
async function checkedSummary(
    comps: Comp[],
    criteria: CompCriteria,
    target: CompTarget,
    checkComps: CheckComps | undefined
): Promise<CompSummary> {
    const titleMismatches = new Set<Comp>();
    const passing = comps.filter(comp => {
        if (compProblem(comp, criteria) !== null) return false;
        if (matchesTarget(comp, target)) return true;
        titleMismatches.add(comp);
        return false;
    });
    const verdicts = checkComps && passing.length > 0 ? await checkComps(passing, target) : undefined;
    // Any eligible current sale takes precedence over older prices. Use the
    // explicitly labeled 180-day fallback only when no current match remains;
    // never choose a window based on whether its median makes a deal profitable.
    const recent = passing.filter(sale => (criteria.now - Date.parse(sale.sold_at)) / DAY_MS <= 90 && verdicts?.get(sale)?.keep !== false);
    const windowDays = recent.length >= 1 ? 90 : 180;
    const summary = summarizeComps(comps.filter(comp => !titleMismatches.has(comp)), { ...criteria, windowDays }, verdicts);
    if (titleMismatches.size) summary.dropped["title does not match target card or grade"] = titleMismatches.size;
    return summary;
}

function compTarget(card: PricedCard, identity: Identity, variant: PricedVariant, grader: string, grade: number | string): CompTarget {
    return {
        cardName: identity.name ?? card.name,
        setName: variant.setName ?? identity.set ?? "",
        cardNumber: identity.cardNumber ?? card.cardNumber,
        printingLabel: printingLabel(identity.printing, identity.set),
        grader,
        grade: String(grade),
        finish: variant.finish,
    };
}

function unavailable<T extends object>(reason: string, extra?: T) {
    return { status: "PRICE_UNAVAILABLE" as const, reason, ...extra };
}

// Checks every graded lookup shares: an identified card, a source that
// can price graded copies by printing, and exactly one matching printing.
function gradedVariantFor(card: PricedCard | null, identity: Identity): ReturnType<typeof variantFor> {
    if (!readyForPricing(identity)) {
        return { reason: "The card isn't fully identified, so graded copies can't be priced." };
    }
    if (!canPrice(`${card?.source}Comps`, ["printing", "grade"])) {
        return { reason: "This price source can't price graded copies by printing." };
    }

    return variantFor(card, identity);
}

// Recent sales of one grade for this card's printing. Where the title
// decides, sales filed under every label of the record are read;
// otherwise only this printing's own label.
async function fetchVariantComps(
    card: PricedCard,
    variant: PricedVariant,
    { grader, grade, fetchComps, criteria, target }: { grader: string; grade: number | string; fetchComps: FetchComps; criteria: CompCriteria; target: CompTarget }
): Promise<Comp[]> {
    const sourceLabels = titleDecidesPrinting(variant.setName)
        ? card.variants.filter((v) => v.recordId === variant.recordId).map((v) => v.name)
        : [variant.name];

    const comps: Comp[] = [];
    const seen = new Set<string | number>();

    for (const sourceLabel of sourceLabels) {
        for (const comp of await fetchComps(variant.recordId, { grader, grade, variant: sourceLabel,
            stopWhen: sales => sales.some(sale => compProblem(sale, criteria) === null && matchesTarget(sale, target)),
        })) {
            const key = comp.id ?? comp.listing_url ?? `${comp.title}|${comp.sold_at}|${comp.price}`;

            if (!seen.has(key)) {
                seen.add(key);
                comps.push(comp);
            }
        }
    }

    return comps;
}

// Verified sold comps for each grade in the estimated range.
export async function gradedPricesFor(
    card: PricedCard | null,
    identity: Identity,
    gradeRange: GradeRange | null,
    {
        fetchComps,
        checkComps,
        grader = "PSA",
        now = Date.now(),
    }: { fetchComps: FetchComps; checkComps?: CheckComps; grader?: string; now?: number }
): Promise<GradedPricing> {
    const { variant, reason } = gradedVariantFor(card, identity);

    if (!variant || !card) return unavailable(reason ?? "There is no card to price.");
    if (!gradeRange) return unavailable("There's no grade estimate to price.");

    const label = printingLabel(identity.printing, identity.set);
    const byGrade: CompSummary[] = [];

    for (let grade = gradeRange.low; grade <= gradeRange.high; grade += 1) {
        const criteria: CompCriteria = { printing: identity.printing, setName: variant.setName, finish: variant.finish, grader, grade, now };
        const target = compTarget(card, identity, variant, grader, grade);
        const comps = await fetchVariantComps(card, variant, { grader, grade, fetchComps, criteria, target });

        byGrade.push(
            await checkedSummary(comps, criteria, target, checkComps)
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

// Verified sold comps for one exact grader and grade: a graded card
// resold as is. Grades are strings, so half grades like "8.5" match
// only themselves.
export async function compsForGrade(
    card: PricedCard | null,
    identity: Identity,
    {
        grader,
        grade,
        fetchComps,
        checkComps,
        now = Date.now(),
    }: { grader: string; grade: number | string; fetchComps: FetchComps; checkComps?: CheckComps; now?: number }
): Promise<SlabPricing> {
    const { variant, reason } = gradedVariantFor(card, identity);

    if (!variant || !card) return unavailable(reason ?? "There is no card to price.");

    const label = printingLabel(identity.printing, identity.set);
    const criteria: CompCriteria = { printing: identity.printing, setName: variant.setName, finish: variant.finish, grader, grade, now };
    const target = compTarget(card, identity, variant, grader, grade);
    const comps = await fetchVariantComps(card, variant, { grader, grade, fetchComps, criteria, target });

    const summary = await checkedSummary(comps, criteria, target, checkComps);

    const details = { printingLabel: label, variant: variant.name, grader, grade, summary };

    if (summary.count === 0) {
        return unavailable(`No verified ${grader} ${grade} sales of the ${label} printing.`, details);
    }

    return {
        status: "PRICED",
        source: card.source,
        printing: variant.printing,
        ...details,
    };
}
