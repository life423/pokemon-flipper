// Grades one live eBay listing and prints a readable summary.
// Usage: npm run evaluate -- <eBay link or item number> [--fresh]
// Reuses the saved answer for a listing while its photos haven't
// changed. --fresh ignores it and pays for a new one.
import "dotenv/config";
import { evaluateListing } from "../grading.js";
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
const { listing, photoCheck, condition, identity, rawPricing, gradedPricing } = evaluation;

function money(value) {
    return `$${value.toFixed(2)}`;
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

if (identity) {
    console.log();
    console.log(`Identity: ${identity.status}`);

    if (identity.name) {
        console.log(
            `  ${identity.name}, ${identity.set} #${identity.cardNumber}, printing ${identity.printingLabel ?? identity.printing}, finish ${identity.finish}, ${identity.language}`
        );
    }

    if (identity.evidence) {
        const { title, itemSpecifics, photo, photoNotes } = identity.evidence;
        console.log(`  Printing evidence: title ${title}, item details ${itemSpecifics}, photos ${photo}`);

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

if (gradedPricing) {
    console.log();

    if (gradedPricing.byGrade) {
        console.log(`Graded sold comps (${gradedPricing.grader}, ${gradedPricing.printingLabel}):`);

        for (const summary of gradedPricing.byGrade) {
            const prices =
                summary.count > 0
                    ? `median ${money(summary.median)}, range ${money(summary.low)} to ${money(summary.high)}, newest ${summary.newestSale}`
                    : "no verified sales";

            const dropped = Object.entries(summary.dropped)
                .map(([reason, count]) => `${count} ${reason}`)
                .join(", ");

            console.log(`  ${summary.grader} ${summary.grade}: ${summary.count} sales, ${prices}, ${summary.confidence} confidence`);

            if (dropped) {
                console.log(`    dropped: ${dropped}`);
            }
        }
    }

    if (gradedPricing.status !== "PRICED") {
        console.log(`Graded prices unavailable: ${gradedPricing.reason}`);
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
