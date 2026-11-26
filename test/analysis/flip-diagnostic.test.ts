import { isolatedDataDir } from "../fixtures/isolated-data.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { flipDiagnostic, readFlipEvents } from "../../server/analysis/flip-diagnostic.ts";

test("per-copy checks share segments, preserve order, and report an interrupted write during replay", async () => {
    const root = randomUUID(), leg = randomUUID();
    const log = flipDiagnostic(root, leg, Date.now, isolatedDataDir);
    await log("started", {});
    await Promise.all(Array.from({ length: 512 }, (_, i) => log(i % 2 ? "observation" : "check", { id: i })));
    await log("page", { listings: [] });
    await log("finished", {});
    const parent = join(isolatedDataDir, "search-diagnostics", "flip", root, leg);
    const folder = join(parent, (await readdir(parent))[0]);
    const files = await readdir(folder);
    assert.equal(files.length, 6);
    const replay = await readFlipEvents(folder);
    assert.equal(replay.damagedLines, 0);
    assert.deepEqual(replay.events.map(e => e.index), Array.from({ length: 515 }, (_, i) => i + 1));
    assert.equal(replay.events[1].evidence.id, 0);
    await appendFile(join(folder, "checks-2.ndjson"), '{"part');
    const interrupted = await readFlipEvents(folder);
    assert.equal(interrupted.events.length, 515);
    assert.equal(interrupted.damagedLines, 1);
});

test("older passes with individual check files remain replayable", async () => {
    const folder = join(isolatedDataDir, randomUUID());
    await mkdir(folder);
    await writeFile(join(folder, "000002-check.json"), JSON.stringify({ index: 2, event: "check" }));
    await writeFile(join(folder, "000001-started.json"), JSON.stringify({ index: 1, event: "started" }));
    assert.deepEqual((await readFlipEvents(folder)).events.map(e => e.event), ["started", "check"]);
});
