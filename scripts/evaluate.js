// Grades one live eBay listing and prints a readable summary.
// Usage: npm run evaluate -- <eBay link or item number> [--fresh]
// Reuses the saved answer for a listing while its photos haven't
// changed. --fresh ignores it and pays for a new one.
import "dotenv/config";
import { evaluateListing } from "../server/analysis/evaluate.js";
import { toItemId } from "./item-id.js";

const STEP_NAMES = { photoCheck: "photo check", condition: "condition report" };

const args = process.argv.slice(2);
const fresh = args.includes("--fresh");
const itemId = toItemId(args.find((arg) => !arg.startsWith("--")));

if (!itemId) {
    console.log("Usage: npm run evaluate -- <eBay link or item number> [--fresh]");
    process.exit(1);
}

console.log(`Evaluating ${itemId}${fresh ? ", ignoring any saved answer" : ""}.`);

const started = Date.now();
let evaluation;

try {
    evaluation = await evaluateListing(itemId, { fresh });
} catch (error) {
    console.error(`Evaluation failed: ${error.message}`);
    process.exit(1);
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
const { listing, photoCheck, condition, identity, rawPricing, gradedPricing, underwriting } = evaluation;

function money(value) {
    return value < 0 ? `-$${Math.abs(value).toFixed(2)}` : `$${value.toFixed(2)}`;
}

function describeRange({ low, likely, high }) {
    return likely === null ? `${low} to ${high}` : `${low} to ${high}, likely ${likely}`;
}

console.log();
console.log(listing.title);
console.log(listing.url);
console.log(`Photos analyzed: ${listing.photosAnalyzed} of ${listing.photosInListing}`);

if (photoCheck) {
    console.log();
    console.log(
        `Photo check: ${photoCheck.photoSufficiency}, ${photoCheck.confidence} confidence, cards: ${photoCheck.cardCount}, holder: ${photoCheck.holder}`
    );

    for (const photo of photoCheck.images) {
        const flags = [
            photo.view,
            photo.usable ? "usable" : "not usable",
            photo.isStockImage ? "stock image" : null,
        ].filter(Boolean);

        const issues = photo.issues.length > 0 ? ` (${photo.issues.join("; ")})` : "";
        console.log(`  Photo ${photo.number}: ${flags.join(", ")}${issues}`);
    }
}

console.log();
console.log(`Grading mode: ${evaluation.gradingMode}`);

for (const reason of evaluation.modeReasons) {
    console.log(`  ${reason}`);
}

console.log(`Result: ${evaluation.gradeStatus}`);

if (condition) {
    for (const area of ["centering", "corners", "edges", "surface"]) {
        const finding = condition[area];
        console.log(`  ${area}: ${finding.visibility}, ${finding.severity}`);

        for (const observation of finding.observations) {
            console.log(`    ${observation}`);
        }
    }

    console.log(`  Grade range: ${describeRange(condition.gradeRange)} (${condition.confidence} confidence)`);
    console.log(`  Raw condition: ${condition.rawCondition}, creases: ${condition.creases}`);
    console.log(`  Authenticity: ${condition.authenticity.concern}`);

    for (const reason of condition.authenticity.reasons) {
        console.log(`    ${reason}`);
    }

    console.log(`  ${condition.summary}`);

    for (const other of evaluation.setAside ?? []) {
        console.log(
            `  Set aside, less cautious: ${describeRange(other.gradeRange)}, ${other.rawCondition}, authenticity ${other.authenticity}`
        );
    }
}

const { slab, slabPricing } = evaluation;

if (slab) {
    console.log();

    const qualifier = slab.gradeQualifier ? ` (${slab.gradeQualifier})` : "";
    console.log(
        `Slab: ${slab.status}, ${slab.grader ?? "grader unreadable"} ${slab.grade ?? "grade unreadable"}${qualifier}, cert ${slab.certNumber ?? "unreadable"}, case ${slab.caseCondition}`
    );

    if (slab.labelText) console.log(`  Label: ${slab.labelText}`);
    if (slab.certUrl) console.log(`  Verify the cert: ${slab.certUrl}`);

    for (const reason of slab.reasons) {
        console.log(`  ${reason}`);
    }
}

if (slabPricing) {
    console.log();

    const s = slabPricing.summary;

    if (s && s.count > 0) {
        console.log(
            `${s.grader} ${s.grade} sold comps (${slabPricing.printingLabel}): ${s.count} sales, median ${money(s.median)}, range ${money(s.low)} to ${money(s.high)}, ${s.confidence} confidence`
        );
    }

    if (slabPricing.status !== "PRICED") {
        console.log(`Slab prices unavailable: ${slabPricing.reason}`);
    }
}

if (identity) {
    console.log();
    console.log(`Identity: ${identity.status}`);

    if (identity.name) {
        console.log(
            `  ${identity.name}, ${identity.set} #${identity.cardNumber}, printing ${identity.printingLabel ?? identity.printing}, finish ${identity.finish}, ${identity.language}`
        );
    }

    if (identity.evidence) {
        const { title, itemSpecifics, label, photo, photoSource, photoNotes } = identity.evidence;
        const slabLabel = evaluation.slab ? `, slab label ${label}` : "";
        console.log(
            `  Printing evidence: title ${title}, item details ${itemSpecifics}${slabLabel}, ${photoSource ?? "photos"} ${photo}`
        );

        for (const note of photoNotes) {
            console.log(`    ${note}`);
        }
    }

    for (const reason of identity.reasons) {
        console.log(`  ${reason}`);
    }
}

if (rawPricing) {
    console.log();

    if (rawPricing.status === "PRICED") {
        console.log(`Raw prices (${rawPricing.printingLabel}):`);

        for (const { condition: rawCondition, price } of rawPricing.prices) {
            console.log(`  ${rawCondition}: ${money(price)}`);
        }
    } else {
        console.log(`Raw prices unavailable: ${rawPricing.reason}`);
    }
}

for (const [grader, graded] of Object.entries(gradedPricing ?? {})) {
    console.log();

    if (graded.byGrade) {
        console.log(`${grader} sold comps (${graded.printingLabel}):`);

        for (const summary of graded.byGrade) {
            const prices =
                summary.count > 0
                    ? `median ${money(summary.median)}, range ${money(summary.low)} to ${money(summary.high)}, newest ${summary.newestSale}`
                    : "no verified sales";

            const dropped = Object.entries(summary.dropped)
                .map(([reason, count]) => `${count} ${reason}`)
                .join(", ");

            console.log(`  ${grader} ${summary.grade}: ${summary.count} sales, ${prices}, ${summary.confidence} confidence`);

            if (dropped) {
                console.log(`    dropped: ${dropped}`);
            }
        }
    }

    if (graded.status !== "PRICED") {
        console.log(`${grader} prices unavailable: ${graded.reason}`);
    }
}

if (underwriting) {
    console.log();

    const shippingText = listing.shipping === null ? "shipping not quoted" : `${money(listing.shipping)} shipping`;
    const priceText = typeof listing.price === "number" ? money(listing.price) : "no price";
    const sale =
        listing.buyingOption === "AUCTION"
            ? `auction at ${priceText} (${listing.bids} bids, ends ${listing.endTime})`
            : `Buy It Now at ${priceText}`;

    console.log(`Money: ${sale}, ${shippingText}`);

    for (const path of underwriting.paths) {
        if (path.status !== "PRICED") {
            console.log(`  ${path.label}: can't price. ${path.reason}`);
            continue;
        }

        const detail =
            path.path === "GRADE"
                ? `${path.tier} ${money(path.gradingFee)}, expected sale ${money(path.expectedSale)}`
                : `sells for ${money(path.salePrice)}${path.priceCondition ? ` (${path.priceCondition})` : ""}`;

        console.log(
            `  ${path.label}: ${detail}; keep ${money(path.expectedNet)}, all-in cost ${money(path.cost)}, profit ${money(path.profit)} (${Math.round(path.roi * 100)}% ROI), worst case ${money(path.downside)}, max bid ${money(path.maxBid)}${path.clears ? ", clears your targets" : ""}`
        );

        if (path.outlook) {
            const grades = path.outlook
                .map((o) => `${path.grader} ${o.grade} ${Math.round(o.probability * 100)}% at ${money(o.price)}${o.filledFrom ? ` (from ${o.filledFrom})` : ""}`)
                .join(", ");

            console.log(`    ${grades}`);
        }
    }

    const best = underwriting.best ? ` (${underwriting.best.label}, max bid ${money(underwriting.best.maxBid)})` : "";
    console.log(`Verdict: ${underwriting.verdict}${best}`);

    for (const reason of underwriting.reasons) {
        console.log(`  ${reason}`);
    }

    for (const note of underwriting.assumptions ?? []) {
        console.log(`  Note: ${note}`);
    }

    if (evaluation.rating) {
        console.log(`Rating: ${evaluation.rating.level}`);

        for (const strength of evaluation.rating.strengths) console.log(`  + ${strength}`);
        for (const concern of evaluation.rating.concerns) console.log(`  - ${concern}`);
        for (const note of evaluation.rating.notes) console.log(`  Note: ${note}`);
    }
}

const tokens = evaluation.usage.reduce(
    (total, step) => total + (step.inputTokens ?? 0) + (step.outputTokens ?? 0),
    0
);

console.log();

if (evaluation.usage.length > 0) {
    const reused = evaluation.reusedSteps.map((step) => STEP_NAMES[step]);
    const reusedText = reused.length > 0 ? ` Reused the saved ${reused.join(" and ")}.` : "";

    console.log(`Took ${seconds}s and ${tokens.toLocaleString()} tokens.${reusedText}`);
} else if (evaluation.answeredAt) {
    const answered = new Date(evaluation.answeredAt).toLocaleString();
    console.log(`Reused the saved answer from ${answered}: no AI calls, took ${seconds}s.`);
}
