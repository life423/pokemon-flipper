import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "../../server/lib/atomic-json.ts";
test("concurrent readers only see complete cache/assessment documents and failed serialization preserves the last answer", async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pokemon-atomic-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, "answer.json");
    const value = { title: "Saved paid assessment", photos: Array(100).fill("unobscured photo") };
    await writeJsonAtomic(file, value);
    const observations: unknown[] = [];
    await Promise.all([
        (async () => { for (let i = 0; i < 25; i++) await writeJsonAtomic(file, { ...value, revision: i }); })(),
        (async () => { for (let i = 0; i < 40; i++) observations.push(JSON.parse(await fs.readFile(file, "utf8"))); })(),
    ]);
    assert.equal(observations.length, 40);
    for (const row of observations) assert.deepEqual((row as typeof value).photos, value.photos);
    const saved = await fs.readFile(file, "utf8");
    await assert.rejects(writeJsonAtomic(file, { unsupported: 1n }));
    assert.equal(await fs.readFile(file, "utf8"), saved);
    assert.deepEqual(await fs.readdir(directory), ["answer.json"]);
});
