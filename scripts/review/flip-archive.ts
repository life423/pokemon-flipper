import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../../server/lib/paths.ts";
import { readFlipEvents } from "../../server/analysis/flip-diagnostic.ts";
import type { Evaluation } from "../../shared/types.ts";

async function names(directory: string, recursive = false) {
    try { return await readdir(directory, { recursive }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

export async function* flipPasses(root = DATA_DIR) {
    const base = path.join(root, "search-diagnostics", "flip");
    const passes = new Set((await names(base, true)).filter(name => /(?:^|[\\/])(?:\d{6,}-\w+\.json|checks-\d+\.ndjson)$/.test(name))
        .map(name => path.dirname(name)));
    for (const folder of [...passes].sort()) yield await readFlipEvents(path.join(base, folder));
}

// Offline readers only. Never invoke the repository's read-through provider cache.
export async function* archiveFiles(folder: "price-cache" | "evaluations", root = DATA_DIR) {
    const directory = path.join(root, folder);
    for (const name of await names(directory)) if (name.endsWith(".json")) {
        yield JSON.parse(await readFile(path.join(directory, name), "utf8"));
    }
}

export function archivedEvaluation(record: { key?: string; data?: { evaluation?: Evaluation }; latestEvaluation?: { evaluation: Evaluation } }) {
    return record.key?.startsWith("private-evaluation:") ? record.data?.evaluation : record.latestEvaluation?.evaluation;
}
