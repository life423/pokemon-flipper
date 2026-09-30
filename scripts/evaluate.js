// Grades one live eBay listing and prints a readable summary.
// Usage: npm run evaluate -- <eBay link or item number>
// Paid: runs up to two vision requests.
import "dotenv/config";
import { evaluateListing } from "../grading.js";
import { toItemId } from "./item-id.js";

const itemId = toItemId(process.argv[2]);

if (!itemId) {
    console.log("Usage: npm run evaluate -- <eBay link or item number>");
    process.exit(1);
}

console.log(`Evaluating ${itemId}. This makes paid AI requests and takes about 20 seconds.`);

const started = Date.now();
let evaluation;

try {
    evaluation = await evaluateListing(itemId);
} catch (error) {
    console.error(`Evaluation failed: ${error.message}`);
    process.exit(1);
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
const { listing, photoCheck, condition } = evaluation;

console.log();
console.log(listing.title);
console.log(listing.url);
console.log(`Photos analyzed: ${listing.photosAnalyzed} of ${listing.photosInListing}`);

if (listing.aspects.Set) {
    console.log(`Set: ${listing.aspects.Set}, card number: ${listing.aspects["Card Number"] ?? "unknown"}`);
}

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

    const { low, likely, high } = condition.gradeRange;
    const likelyText = likely === null ? "" : `, likely ${likely}`;

    console.log(`  Grade range: ${low} to ${high}${likelyText} (${condition.confidence} confidence)`);
    console.log(`  Raw condition: ${condition.rawCondition}, creases: ${condition.creases}`);
    console.log(`  Authenticity: ${condition.authenticity.concern}`);

    for (const reason of condition.authenticity.reasons) {
        console.log(`    ${reason}`);
    }

    console.log(`  ${condition.summary}`);
}

const tokens = evaluation.usage.reduce(
    (total, step) => total + (step.inputTokens ?? 0) + (step.outputTokens ?? 0),
    0
);

console.log();
console.log(`Took ${seconds}s and ${tokens.toLocaleString()} tokens.`);
