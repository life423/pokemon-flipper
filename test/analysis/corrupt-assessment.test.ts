import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../../server/lib/paths.ts";
import { loadSaved } from "../../server/analysis/store.ts";
test("a corrupt paid assessment is preserved and reported, while a genuinely missing one can be created", async t => {
    const id = `corruptassessment${Date.now()}`;
    const file = path.join(DATA_DIR, "evaluations", id + ".json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{"saved paid work":');
    t.after(() => fs.rm(file, { force: true }));
    await assert.rejects(loadSaved(id), /saved photo assessment could not be read/);
    assert.equal(await fs.readFile(file, "utf8"), '{"saved paid work":');
    assert.equal(await loadSaved(id + "-missing"), null);
});
