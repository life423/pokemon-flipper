import "./fixtures/isolated-data.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { ROOT } from "../server/lib/paths.ts";

test("stripped app exposes the sniper and rejects retired workflows without provider work", { timeout: 15_000 }, async t => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/start.mjs"], {
        cwd: ROOT,
        env: { ...process.env, PORT: "0", POKEMON_FLIPPER_STORAGE: "file", DOTENV_CONFIG_PATH: path.join(process.env.POKEMON_FLIPPER_DATA_DIR!, "no-env-file") },
        stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => { child.kill(); });
    const base = await new Promise<string>((resolve, reject) => {
        let output = "";
        const timeout = setTimeout(() => reject(new Error("App startup timed out")), 10_000);
        child.stdout.on("data", chunk => {
            output += String(chunk);
            const match = /Server listening on (http:\/\/localhost:\d+)/.exec(output);
            if (match) { clearTimeout(timeout); resolve(match[1]); }
        });
        child.once("error", error => { clearTimeout(timeout); reject(error); });
        child.once("exit", code => { clearTimeout(timeout); reject(new Error(`App exited with ${code}`)); });
    });
    const headers = { "X-Pokemon-Flipper": "1", "Content-Type": "application/json" };
    for (const route of ["/api/deals", "/api/deals/new", "/api/search-plan", "/api/listings/123/evaluate", "/api/camera/grade", "/api/shortlist", "/api/flip"]) {
        for (const method of ["GET", "POST"]) {
            const response = await fetch(base + route, { headers, method, ...(method === "POST" ? { body: "{}" } : {}) });
            assert.equal(response.status, 404, `${method} ${route}`);
        }
    }
    const queue = await fetch(base + "/api/sniper?mode=reminder", { headers });
    assert.equal(queue.status, 200);
    assert.deepEqual(await queue.json(), { jobs: [] });
    const invalid = await fetch(base + "/api/sniper/preview", {
        method: "POST", headers, body: JSON.stringify({ mode: "reminder", url: "https://example.com/123" }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await fetch(base + "/api/sniper")).status, 403);
});
