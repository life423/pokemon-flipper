// Grades the same live listing several times at once and shows
// how much the answers vary between runs.
// Usage: npm run consistency -- <eBay link or item number> [runs]
// Paid: every run makes up to two vision requests.
import "dotenv/config";
import { evaluateListing } from "../grading.js";
import { toItemId } from "./item-id.js";

const AREAS = ["centering", "corners", "edges", "surface"];

const itemId = toItemId(process.argv[2]);
const runs = Number(process.argv[3] ?? 5);

if (!itemId || !Number.isInteger(runs) || runs < 2 || runs > 10) {
    console.log("Usage: npm run consistency -- <eBay link or item number> [runs, 2 to 10]");
    process.exit(1);
}

console.log(`Grading ${itemId} ${runs} times at once. Paid: up to ${runs * 2} vision requests.`);

const started = Date.now();

const results = await Promise.allSettled(
    // Always fresh and never saved: the point is to see the spread.
    Array.from({ length: runs }, () =>
        evaluateListing(itemId, { fresh: true, remember: false })
    )
);

// One comparable line per run: the fields a verdict depends on.
function summarize(evaluation) {
    const { photoCheck, condition } = evaluation;

    const areas = Object.fromEntries(
        AREAS.map((area) => [
            area,
            condition
                ? `${condition[area].visibility} ${condition[area].severity}`
                : "-",
        ])
    );

    return {
        photoCheck: photoCheck
            ? `${photoCheck.photoSufficiency} ${photoCheck.confidence}`
            : "-",
        clearPhotos: photoCheck
            ? photoCheck.images
                  .filter((photo) => photo.usable && !photo.isStockImage)
                  .map((photo) => photo.view)
                  .sort()
                  .join(",") || "none"
            : "-",
        holder: photoCheck?.holder ?? "-",
        mode: evaluation.gradingMode,
        ...areas,
        raw: condition?.rawCondition ?? "-",
        range: condition
            ? `${condition.gradeRange.low}-${condition.gradeRange.high}`
            : "-",
        likely: condition ? String(condition.gradeRange.likely ?? "none") : "-",
        confidence: condition?.confidence ?? "-",
        authenticity: condition?.authenticity.concern ?? "-",
    };
}

const rows = [];
let tokens = 0;

results.forEach((result, index) => {
    if (result.status === "rejected") {
        console.log(`Run ${index + 1} failed: ${result.reason.message}`);
        return;
    }

    for (const step of result.value.usage) {
        tokens += (step.inputTokens ?? 0) + (step.outputTokens ?? 0);
    }

    rows.push({ run: index + 1, row: summarize(result.value) });
});

if (rows.length === 0) {
    process.exit(1);
}

console.log();
console.log(results.find((r) => r.status === "fulfilled").value.listing.title);
console.log();

for (const { run, row } of rows) {
    console.log(`Run ${run}`);

    for (const [field, value] of Object.entries(row)) {
        console.log(`  ${field.padEnd(13)}${value}`);
    }
}

console.log();
console.log("Spread across runs");

for (const field of Object.keys(rows[0].row)) {
    const counts = new Map();

    for (const { row } of rows) {
        counts.set(row[field], (counts.get(row[field]) ?? 0) + 1);
    }

    const values = [...counts]
        .map(([value, count]) => `${value} x${count}`)
        .join(", ");

    const label = counts.size > 1 ? "VARIES" : "steady";
    console.log(`  ${field.padEnd(13)}${label.padEnd(8)}${values}`);
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);

console.log();
console.log(`Took ${seconds}s and ${tokens.toLocaleString()} tokens in total.`);
