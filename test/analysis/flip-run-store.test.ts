import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FlipRunConflict, withFlipRun } from "../../server/analysis/flip-run-store.ts";

test("a restarted worker recovers the source cursor, accepted photo task and outstanding dispatch under the original account", async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flip-worker-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, "run.sqlite"), signal = new AbortController().signal;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
        import { withFlipRun } from "./server/analysis/flip-run-store.ts";
        await withFlipRun(process.argv[1], "leg", "owner", "criteria", new AbortController().signal, async queue => {
            await queue.savePage({ offset: 200 });
            await queue.start("one","inspect_photos");
            await queue.accept("one", { done:["inspect_photos"], next:["check_sales"], evidence:"original front" });
            await queue.start("two","inspect_photos");
            process.exit(9);
        });`, file], { timeout: 15000, encoding: "utf8" });
    assert.equal(child.status, 9, child.stderr);
    await assert.rejects(withFlipRun(file, "leg", "different", "criteria", signal, async () => {}),
        error => error instanceof FlipRunConflict && !error.running);
    await withFlipRun(file, "leg", "owner", "criteria", signal, async queue => {
        assert.deepEqual(queue.checkpoint, { offset: 200 });
        assert.deepEqual(queue.task("one")?.receipt, { done:["inspect_photos"], next:["check_sales"], evidence:"original front" });
        assert.equal(queue.task("two")?.inFlight, "inspect_photos");
        await assert.rejects(withFlipRun(file, "leg", "owner", "criteria", signal, async () => {}),
            error => error instanceof FlipRunConflict && error.running);
        await queue.finish({ offset: 400 }, { decision: "WAIT" });
    });
    await withFlipRun(file, "leg", "owner", "criteria", signal, async queue => {
        assert.deepEqual(queue.previous, { decision: "WAIT" });
        assert.deepEqual(queue.checkpoint, { offset: 400 });
        assert.equal(queue.task("two")?.inFlight, "inspect_photos");
    });
});
