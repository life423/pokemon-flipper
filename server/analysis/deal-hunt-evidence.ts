import { auctionOpportunity, withinOpportunityWindow } from "../../shared/auction-opportunity.ts";
import { freshListingTime, GRADING_WATCH_FRESH_MS, type GradingOpportunity } from "../../shared/grading-watch.ts";
import type { DealHuntAction, DealHuntGoal } from "../../shared/deal-hunt.ts";
import { CONDITION_NAMES, isRawCondition } from "../../shared/conditions.ts";
import { dollars } from "../../shared/format.ts";
import { readyForPricing } from "../../shared/identity.ts";
import { cents, meetsMoneyTargets } from "../../shared/money/cents.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { isRawSoldPrice, referencePriceReason } from "../../shared/money/price-evidence.ts";
import { rawBuyGuidance } from "../../shared/money/raw-buy-guidance.ts";
import { slabBuyGuidance } from "../../shared/money/slab-buy-guidance.ts";
import { acquisitionCost } from "../../shared/money/underwriting.ts";
import { displayedRawGrade, observedCardKind, photoCoverage, slabLabelConfidence } from "../../shared/photo-evidence.ts";
import { currentPriceEvidence } from "../../shared/pricing-freshness.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS } from "../../shared/search-diagnostic.ts";
import { verifiedSlabMarketKey } from "../../shared/slab-market.ts";
import { soldMarketPrice } from "../../shared/sold-evidence.ts";
import type { CompSummary, Evaluation, Grader, PricedPath, Targets } from "../../shared/types.ts";
import type { DealHuntCandidate, DealHuntOutcome } from "./deal-hunt.ts";
import { MIN_RECENT_HUNT_SALES, rankHuntMarkets, salesForExit, type HuntMarket } from "./same-set-markets.ts";

function listingTerms(value: Evaluation, now: number) {
    const { price, shipping, availability, termsCheckedAt } = value.listing;
    const age = now - Date.parse(termsCheckedAt ?? "");
    const total = price !== null && Number.isFinite(price) && price > 0 && shipping !== null &&
        Number.isFinite(shipping) && shipping >= 0 && !value.underwriting?.shippingUnconfirmed
        ? acquisitionCost(price, shipping, MONEY_CONFIG.buying) : null;
    const status = availability === "UNAVAILABLE" ? "This listing has ended." :
        availability !== "ACTIVE" ? "Availability is unverified." :
        total === null ? "The delivered purchase total is unverified." :
        !(age >= 0 && age <= BEST_BUY_TERMS_MAX_AGE_MS) ? "The saved purchase terms need a fresh availability and shipping check." : "";
    const costs = total === null ? "" : `Item ${dollars(price)}, shipping ${dollars(shipping)}, total with estimated tax ${dollars(total)}.`;
    return { total, status, text: [costs, status, termsCheckedAt && `Terms checked ${termsCheckedAt}.`].filter(Boolean).join(" ") };
}

function photos(value: Evaluation, slab: boolean) {
    if (!value.photoCheck) return "There is no saved photo assessment.";
    const coverage = photoCoverage(value.photoCheck);
    const counts = `${value.listing.photosAnalyzed} of ${value.listing.photosInListing} listing photos assessed, including ${coverage.fronts} front and ${coverage.backs} back overviews.`;
    if (slab) {
        const label = slabLabelConfidence(value) ? `The holder confirms ${value.slab?.grader} ${value.slab?.grade}.` : "The holder grade and identity are unconfirmed.";
        return [counts, label, value.slab?.caseCondition === "SCRATCHED" && "The holder has visible scratches."].filter(Boolean).join(" ");
    }
    const grade = displayedRawGrade(value), wear = value.condition?.rawCondition;
    return [counts, isRawCondition(wear) && `Visible condition is ${CONDITION_NAMES[wear]}.`,
        grade?.range.likely ? `Estimated grade ${grade.range.likely} (${grade.confidence.toLowerCase()} confidence).` : "The saved photos did not establish a likely grade.",
        value.condition?.surface?.observations?.[0] || value.condition?.limitations[0]].filter(Boolean).join(" ");
}

// The timestamp and amounts come from matched transactions. Legacy rows without a
// transaction type remain visible in the main evaluation but cannot certify this hunt.
function matchedPrice(summary: CompSummary | null | undefined, now: number) {
    if (!summary?.count || !summary.sales?.some(sale => {
        const age = now - Date.parse(sale.soldAt);
        return ["auction", "fixed_price", "best_offer_accepted"].includes(sale.saleType ?? "") &&
            Number.isFinite(sale.price) && sale.price > 0 && age >= 0 && age <= (summary.windowDays === 180 ? 180 : 90) * 86_400_000;
    })) return null;
    return soldMarketPrice(summary);
}

function gradeMarket(value: Evaluation, grader: Grader, grade: number) {
    const price = value.gradedPricing?.[grader];
    if (!price || !readyForPricing(value.identity) || price.printing !== value.identity?.printing || price.status !== "PRICED") return undefined;
    return price.byGrade?.find(row => row.grader === grader && Number(row.grade) === grade);
}

function rawMarket(value: Evaluation, now: number) {
    const pricing = value.rawPricing;
    if (!readyForPricing(value.identity) || !pricing || pricing.printing !== value.identity?.printing) return null;
    const condition = value.condition?.rawCondition;
    const row = pricing.prices?.find(row => row.condition === condition && isRawSoldPrice(row));
    const comp = row?.comps ?? pricing.ebayComps?.find(row => row.grader === "RAW" && row.grade === condition);
    return row && comp?.grade === condition && comp?.grader === "RAW" && matchedPrice(comp, now) === row.price ? row : null;
}

function slabMarket(value: Evaluation, now: number) {
    const pricing = value.slabPricing, summary = pricing?.summary;
    if (!verifiedSlabMarketKey(value, { allowScratchedCase: true }) || !pricing || !summary ||
        pricing.status !== "PRICED" || pricing.printing !== value.identity?.printing ||
        pricing.grader !== value.slab?.grader || String(pricing.grade) !== value.slab?.grade ||
        summary.grader !== value.slab?.grader || String(summary.grade) !== value.slab?.grade) return null;
    const price = matchedPrice(summary, now);
    return price === null ? null : { price, count: summary.count };
}

function gradeScenarios(value: Evaluation, now: number) {
    const grade = value.condition?.gradeRange?.likely;
    if (!grade) return [];
    return (value.underwriting?.paths ?? []).flatMap(path => {
        if (path.path !== "GRADE" || path.status !== "PRICED" || !path.grader || referencePriceReason(value, path)) return [];
        const grader = path.grader;
        const at = (number: number) => {
            const summary = gradeMarket(value, grader, number);
            const estimate = matchedPrice(summary, now);
            const row = path.outlook?.find(row => row.grade === number && row.filledFrom === null && row.price === estimate);
            return row ? { grade: number, profit: (cents(row.net) - cents(path.cost)) / 100 } : null;
        };
        return [{ path, likely: at(grade), lower: at(grade - 1) }];
    });
}

type Scenarios = ReturnType<typeof gradeScenarios>;
function gradeMath(scenarios: Scenarios) {
    if (!scenarios.length) return "The photo assessment and matched sales do not establish a priced grading route.";
    return scenarios.map(({ path, likely, lower }) => {
        const render = (label: string, scenario: typeof likely) => scenario
            ? `${label} (${path.grader} ${scenario.grade}), the projected ${scenario.profit < 0 ? "loss" : "profit"} is ${dollars(Math.abs(scenario.profit))} after all costs.`
            : `${label}, the saved sales do not support a profit estimate.`;
        return [`${path.grader} grading and submission shipping add ${dollars(path.fixedCosts)}.`,
            render("At the likely grade", likely), render("One grade lower", lower)].join(" ");
    }).join(" ");
}

export function dealHuntCandidate(value: Evaluation, goal: DealHuntGoal, clock: number | (() => number) = Date.now, market?: HuntMarket | HuntMarket[], targets: Targets = MONEY_CONFIG.targets, maxDelivered?: number): DealHuntCandidate | null {
    const timestamp = typeof clock === "number" ? () => clock : clock;
    const kind = observedCardKind(value);
    const auction = value.listing.buyingOption === "AUCTION";
    if (!kind || (auction && goal === "collect_slab") ||
        (goal === "grade_raw" && kind !== "raw") || (goal === "collect_slab" && kind !== "graded")) return null;
    const slab = kind === "graded";
    const grade = value.condition?.gradeRange?.likely;
    const gradeRoute = goal === "grade_raw" || (!slab && value.underwriting?.best?.path === "GRADE");
    function saleEvidence(now: number) {
        const slabSales = slab ? slabMarket(value, now) : null;
        const reference = slab && !slabSales ? slabBuyGuidance(value, now) : null;
        const raw = slab ? null : rawMarket(value, now);
        if (slabSales) return `${slabSales.count} matched ${value.slab?.grader} ${value.slab?.grade} sales. Sold estimate ${dollars(slabSales.price)}.`;
        if (reference) return `${reference.evidence} Estimated market value ${dollars(reference.price)}. ${reference.caseNote ?? ""}`.trim();
        if (slab) return "No recent sales verified for this printing, grader and grade.";
        const observations = raw ? [`Condition-matched raw sale estimate ${dollars(raw.price)}.`] : [];
        if (!raw) {
            const guidance = rawBuyGuidance(value, now, targets);
            if (guidance) observations.push(guidance.explanation);
        }
        if (grade) for (const grader of ["PSA", "CGC"] as const) {
            for (const number of [grade, grade - 1]) {
                const summary = gradeMarket(value, grader, number);
                const estimate = matchedPrice(summary, now);
                if (estimate !== null && summary) observations.push(`The ${grader} ${number} estimate is ${dollars(estimate)} from ${summary.count} matched sales.`);
            }
        }
        return observations.join(" ") || "No matching raw or grade-specific sales are established in the saved research.";
    }
    function outcome(completed: ReadonlySet<DealHuntAction>): DealHuntOutcome | null {
        if (!completed.has("check_listing") || !completed.has("inspect_photos")) return null;
        const now = timestamp();
        if (auction) {
            if (!withinOpportunityWindow(value.listing.endTime, now)) return { decision: "WAIT", section: "sales", reason: "The auction is outside the remaining ten-hour opportunity window." };
            if (!completed.has("check_sales")) return null;
            const offer = auctionOpportunity(value, targets, now, maxDelivered);
            if (!offer) return { decision: "WAIT", section: "sales", reason: "The latest bid and matched sales did not establish a current below-market auction for this copy." };
            if ((offer.routeKind === "GRADE" || goal === "grade_raw") && !completed.has("calculate_grading")) return null;
            if (goal === "grade_raw" && offer.routeKind !== "GRADE") return { decision: "WAIT", section: "grading", reason: "A profitable grading route at the next bid has not been established." };
            return { decision: offer.status === "BID" ? "BID" : "WAIT", section: offer.routeKind === "GRADE" ? "grading" : "sales", reason: offer.reason };
        }
        if (!slab && !readyForPricing(value.identity)) {
            const status = value.listing.availability === "UNAVAILABLE" ? "The listing has ended. " : "";
            return { decision: "WAIT", section: "photos", reason: status + "The photos did not establish the exact printing needed to price this copy." };
        }
        if (!completed.has("check_sales") || gradeRoute && !completed.has("calculate_grading")) return null;
        let section: DealHuntOutcome["section"] = gradeRoute ? "grading" : "sales";
        let hasGradeComparisons = false;
        const terms = listingTerms(value, now);
        const slabSales = slab ? slabMarket(value, now) : null;
        const reference = slab && !slabSales ? slabBuyGuidance(value, now) : null;
        const markets = goal === "resell" ? rankHuntMarkets([value], null, goal, "any_card", now, 1) : [];
        if (market) markets.push(...(Array.isArray(market) ? market : [market]));
        let exit: PricedPath | undefined;
        let reason: string;
        let supported = false;
        if (goal === "collect_slab") {
            const price = slabSales?.price ?? reference?.price;
            reason = price && terms.total !== null ? `The estimated purchase total is ${dollars(terms.total)} against ${dollars(price)} ${slabSales ? "from matched sales" : "from the market reference"}.` : saleEvidence(now);
            if (!slabSales && reference) reason += " An individual matched transaction is still needed for a buy.";
            const intact = !!verifiedSlabMarketKey(value);
            if (slabSales && !intact) reason += " The holder condition limits a direct price comparison.";
            supported = !!slabSales && intact && terms.total !== null && cents(terms.total) <= cents(slabSales.price) &&
                !!value.underwriting && value.underwriting.verdict !== "NEEDS_REVIEW" &&
                !value.deeperPhotoReview?.findings.some(finding => finding.impact === "NEW_CONCERN");
        } else if (gradeRoute) {
            const scenarios = gradeScenarios(value, now);
            hasGradeComparisons = scenarios.some(({ likely, lower }) => likely && lower);
            const profitable = scenarios.filter(({ path, likely, lower }) => path.clears && path.profit > 0 && likely && likely.profit > 0 && lower && lower.profit > 0);
            const viable = profitable.find(({ path }) => goal !== "resell" || salesForExit(value, path, markets, now) >= MIN_RECENT_HUNT_SALES);
            exit = (viable ?? profitable[0] ?? scenarios.find(({ path }) => path.profit > 0))?.path;
            reason = gradeMath(viable ? [viable] : scenarios);
            supported = !!viable && value.underwriting?.verdict.startsWith("BUY") === true;
            if (!supported && goal === "resell" && value.underwriting?.verdict.startsWith("BUY")) {
                const raw = rawMarket(value, now);
                const rawPath = value.underwriting.paths.find((path): path is PricedPath => path.path === "RAW" && path.status === "PRICED");
                if (raw && rawPath?.clears && rawPath.profit > 0 && rawPath.salePrice === raw.price && !referencePriceReason(value, rawPath)) {
                    supported = true;
                    exit = rawPath;
                    section = "sales";
                    reason = `Selling this copy raw at the condition-matched ${dollars(raw.price)} estimate projects ${dollars(rawPath.profit)} after purchase and selling costs.`;
                }
            }
        } else {
            const raw = slab ? null : rawMarket(value, now);
            const path = value.underwriting?.best;
            exit = path ?? undefined;
            supported = !!path && ((!!raw && path.path === "RAW") || (!!slabSales && path.path === "GRADED_RESALE")) &&
                path.clears && path.profit > 0 && !referencePriceReason(value, path) && value.underwriting?.verdict.startsWith("BUY") === true;
            reason = path && (raw || slabSales) ? `${path.label} projects ${dollars(path.profit)} after purchase and selling costs.` :
                reference ? `${reference.explanation} ${reference.evidence}` : saleEvidence(now);
        }
        if (goal === "resell" && exit) {
            const sales = salesForExit(value, exit, markets, now);
            const label = exit.path === "RAW" && exit.priceCondition ? `${CONDITION_NAMES[exit.priceCondition]} raw` :
                exit.path === "GRADE" ? `${exit.grader} ${grade}` : `${value.slab?.grader} ${value.slab?.grade}`;
            reason += ` ${sales} matched ${label} ${sales === 1 ? "sale" : "sales"} in the last 30 days.`;
            if (sales < MIN_RECENT_HUNT_SALES) {
                supported = false;
                reason += ` The resale hunt needs at least ${MIN_RECENT_HUNT_SALES} to support buying.`;
            }
            if (exit.profit > 0 && !exit.clears) reason += " The projected return falls short of your profit or ROI target.";
        }
        const stalePrices = supported && !currentPriceEvidence(value, now);
        const seller = value.listing.seller;
        const sellerConcern = !!seller && ((seller.feedbackScore != null && seller.feedbackScore < 10) ||
            (seller.feedbackPercentage != null && seller.feedbackPercentage < 98));
        const cautions = [terms.status, stalePrices && "The saved market evidence needs updating.", sellerConcern && "The seller has limited or low feedback."].filter(Boolean);
        return { decision: supported && cautions.length === 0 ? "BUY" : "WAIT", reason: [reason, ...cautions].join(" "), section,
            alternateSections: section === "grading" && hasGradeComparisons ? ["sales"] : undefined };
    }
    return {
        listingId: value.listing.id, title: value.listing.title,
        summary: [slab ? "Graded card" : "Raw card", value.listing.cardCondition && `seller describes it as ${value.listing.cardCondition}`,
            value.listing.createdAt && `listed ${value.listing.createdAt}`].filter(Boolean).join(" · "),
        available(completed) {
            const actions: DealHuntAction[] = ["check_listing", "inspect_photos", "check_sales"];
            if (!slab && completed.has("inspect_photos") && completed.has("check_sales")) actions.push("calculate_grading");
            return actions.filter(action => !completed.has(action));
        },
        read(action) {
            const now = timestamp();
            switch (action) {
                case "check_listing": {
                    if (!auction) return listingTerms(value, now).text;
                    const { price, endTime, auctionQuote } = value.listing;
                    return [price != null && `Current auction price ${dollars(price)}.`, auctionQuote?.minimumBid != null && `Next bid ${dollars(auctionQuote.minimumBid)}.`, endTime && `Ends ${endTime}.`].filter(Boolean).join(" ") || "Auction terms are unavailable.";
                }
                case "inspect_photos": return photos(value, slab);
                case "check_sales": return saleEvidence(now);
                case "calculate_grading": {
                    if (!auction) return gradeMath(gradeScenarios(value, now));
                    const grading = auctionOpportunity(value, targets, now, maxDelivered)?.grading;
                    return grading ? `At the next bid, ${grading.grader} ${grading.likelyGrade} projects ${dollars(grading.likelyProfit)} profit and ${grading.grader} ${grading.lowerGrade} projects ${dollars(grading.lowerProfit)}. Grading and submission add ${dollars(grading.gradingCosts)}.`
                        : "The next bid and grade-specific sales did not support a grading opportunity.";
                }
            }
        },
        outcome,
    };
}

// The buyer reviewer calls this with its existing evidence. Checking a watch
// never starts a second price lookup or photo assessment.
export function newGradingOpportunity(value: Evaluation, now: number, targets: Targets, dates: Pick<Evaluation["listing"], "listedAt" | "createdAt"> = value.listing): GradingOpportunity | undefined {
    const listed = freshListingTime(dates, now);
    const terms = listingTerms(value, now);
    if (listed === null || terms.status || terms.total === null || Date.parse(value.listing.endTime ?? "") <= now ||
        !value.photoCheck || value.condition?.authenticity.concern !== "NONE_SEEN" || value.condition.creases === "SUSPECTED" ||
        value.deeperPhotoReview?.findings.some(finding => finding.impact === "NEW_CONCERN") ||
        !value.underwriting?.verdict.startsWith("BUY")) return;
    const coverage = photoCoverage(value.photoCheck);
    if (!coverage.fronts || !coverage.backs) return;
    const checked = dealHuntCandidate(value, "grade_raw", now)?.outcome(new Set(["check_listing", "inspect_photos", "check_sales", "calculate_grading"]));
    if (checked?.decision !== "BUY") return;
    const markets = rankHuntMarkets([value], null, "resell", "any_card", now, 1, true);
    for (const { path, likely, lower } of gradeScenarios(value, now).sort((a, b) => b.path.profit - a.path.profit)) {
        if (!path.grader || !path.clears || path.profit <= 0 || !likely || likely.profit <= 0 || !lower || lower.profit <= 0) continue;
        if (!meetsMoneyTargets(cents(path.cost) + cents(likely.profit), cents(path.cost), targets.minProfit, targets.minRoi)) continue;
        const marketAt = (grade: number) => markets.find(m => m.kind === "raw" && m.grader === path.grader && m.grade === grade);
        const high = marketAt(likely.grade), low = marketAt(lower.grade);
        if (!high?.liquidThrough || high.sales30 < MIN_RECENT_HUNT_SALES || !low) continue;
        const validUntil = Math.min(Date.parse(value.listing.termsCheckedAt!) + BEST_BUY_TERMS_MAX_AGE_MS,
            listed + GRADING_WATCH_FRESH_MS, high.liquidThrough, Date.parse(low.latestSaleAt) + 30 * 86_400_000,
            Date.parse(value.listing.endTime ?? "") || Infinity);
        if (!(validUntil > now)) continue;
        return { grader: path.grader, listingDate: new Date(listed).toISOString(), dateSource: dates.listedAt ? "listed" : "created", validUntil, delivered: terms.total,
            gradingCosts: path.fixedCosts, likely: { ...likely, sales30: high.sales30 }, lower: { ...lower, sales30: low.sales30 } };
    }
}
