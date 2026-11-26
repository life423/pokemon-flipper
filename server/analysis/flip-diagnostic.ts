import { randomUUID } from "node:crypto";
import path from "node:path";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { writeJsonAtomic } from "../lib/atomic-json.ts";
import { DATA_DIR } from "../lib/paths.ts";
import { isSearchDiagnosticId } from "./search-diagnostic-store.ts";

// Each immutable event belongs to one pass of one leg of the original account.
// A stopped process leaves its completed events available for an offline replay.
export function flipDiagnostic(searchId: string, legId: string, now = Date.now, directory = DATA_DIR) {
    if (!isSearchDiagnosticId(searchId) || !isSearchDiagnosticId(legId)) throw new Error("Invalid search diagnostic account.");
    const pass = randomUUID();
    const folder = path.join(directory, "search-diagnostics", "flip", searchId, legId, pass);
    let sequence = 0;
    let warned = false;
    let writing = Promise.resolve();
    let folderReady = false;
    return async (event: "started" | "page" | "screened" | "queue" | "check" | "observation" | "finished", evidence: object) => {
        const index = ++sequence;
        try {
            const receipt = { version: 1, searchId, legId, pass, index, at: new Date(now()).toISOString(), event, evidence };
            if (event === "check" || event === "observation") {
                // Frequent per-copy events share small append-only files. Serialize writes so
                // concurrent observations cannot interleave. A torn line leaves later records readable.
                const line = "\n" + JSON.stringify(receipt) + "\n";
                const segment = path.join(folder, "checks-" + Math.floor((index - 1) / 256) + ".ndjson");
                const write = writing.then(async () => {
                    if (!folderReady) { await mkdir(folder, { recursive: true }); folderReady = true; }
                    await appendFile(segment, line, { mode: 0o600 });
                });
                writing = write.catch(() => {});
                await write;
            } else {
                if (event === "finished") await writing;
                await writeJsonAtomic(path.join(folder, String(index).padStart(6, "0") + "-" + event + ".json"), receipt);
            }
        } catch {
            // A missing audit event must never cause a second paid assessment.
            if (!warned) console.warn("Some flip diagnostics could not be saved for search", searchId);
            warned = true;
        }
    };
}

// Pages remain individually replayable. Old passes contain only numbered JSON files.
export async function readFlipEvents(folder: string) {
    const names = await readdir(folder);
    const events = [];
    let damagedLines = 0;
    for (const name of names) {
        if (/^\d{6,}-[a-z]+\.json$/.test(name)) {
            events.push(JSON.parse(await readFile(path.join(folder, name), "utf8")));
        } else if (/^checks-\d+\.ndjson$/.test(name)) {
            for (const line of (await readFile(path.join(folder, name), "utf8")).split("\n")) {
                if (!line.trim()) continue;
                try { events.push(JSON.parse(line)); } catch { damagedLines++; }
            }
        }
    }
    return { events: events.sort((a, b) => a.index - b.index), damagedLines };
}
