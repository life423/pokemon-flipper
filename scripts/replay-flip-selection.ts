import { normalizedPhoto } from "../shared/listing-evidence.ts";
import { archiveFiles, archivedEvaluation, flipPasses } from "./review/flip-archive.ts";
import { replayFlipSelection, type PhotoArchive } from "./review/flip-selection-replay.ts";

const archive: PhotoArchive = { evaluations: new Map(), fronts: new Map() };
for (const folder of ["evaluations","price-cache"] as const) {
    for await (const record of archiveFiles(folder)) {
        const e = archivedEvaluation(record);
        if (e?.photoCheck && e.listing.id) {
            const group = archive.evaluations.get(e.listing.id) ?? [];
            group.push(e);
            archive.evaluations.set(e.listing.id, group);
        }
        const url = /^photo-find:v\d+:[^:]+:(https:\/\/.+)$/.exec(record.key ?? "")?.[1];
        if (url && record.data?.card && record.data.printingMarks) {
            const key = normalizedPhoto(url), group = archive.fronts.get(key) ?? [];
            group.push(record.data);
            archive.fronts.set(key, group);
        }
    }
}
const passes = [];
for await (const saved of flipPasses()) {
    const result = await replayFlipSelection(saved, archive);
    if (result) passes.push(result);
}
const rows = passes.flatMap(p => p.rows), selections = passes.flatMap(p => p.selections);
const count = (subset: typeof rows) => new Set(subset.map(r => r.id)).size;
const seen = new Set(rows.filter(r => r.previewed || r.galleryStarted).map(r => r.id));
const rejected = rows.filter(r => r.beforePhotos && !seen.has(r.id));
const withImages = new Set(rejected.filter(r => r.hasSnapshot).map(r => r.id));
const buys = new Set(rows.filter(r => r.confirmedBuy).map(r => r.id));
console.log(JSON.stringify({ passes: passes.length, finished: passes.filter(p => p.complete).length,
    incompleteEventSequences: passes.filter(p => !p.contiguous).length, distinctListings: count(rows),
    rejectedBeforeAnyRecordedPhotos: count(rejected), rejectedWithSnapshot: withImages.size,
    rejectedWithoutSnapshot: count(rejected) - withImages.size,
    rejectedWithIndependentIdentityEvidence: count(rejected.filter(r => r.physical !== "unknown")),
    priorNameRejectionsPassingCurrentTitleChecks: count(rejected.filter(r => r.clearsTitleScreen)),
    rejectedWithIndependentlySupportedMargin: count(rejected.filter(r => r.supportedMargin)),
    recordedBuysAmongTheseRejections: count(rejected.filter(r => buys.has(r.id))),
    replayedSelections: selections.length, changedFirstVsCheapest: selections.filter(s => s.order[0] !== s.baseline[0]).length,
    cases: Object.fromEntries([...new Set(rows.flatMap(r => r.cases))].map(c => [c, count(rows.filter(r => r.cases.includes(c)))])),
    ...(process.argv.includes("--details") && { passes }) }, null, 2));
