import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { localApi } from "../../server/lib/local-api.ts";
test("untrusted websites and simple GETs cannot reach provider work; local UI/CLI requests still work", async t => {
    const app = express(); let providerCalls = 0;
    app.use("/api", localApi); app.use(express.json());
    app.get("/api/sniper", (_req, res) => { providerCalls++; res.json({ ok: true }); });
    app.post("/api/sniper", (_req, res) => { providerCalls++; res.json({ ok: true }); });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    for (const headers of [{}, { "X-Pokemon-Flipper": "1", Origin: "https://untrusted.example" }, { "X-Pokemon-Flipper": "1", Host: "rebound.example" }, { "X-Pokemon-Flipper": "1", "Sec-Fetch-Site": "cross-site" }] as Record<string, string>[]) {
        const status = await new Promise<number | undefined>((resolve, reject) => {
            const request = http.get(base + "/api/sniper?q=charizard", { headers }, response => { response.resume(); response.on("end", () => resolve(response.statusCode)); }); request.on("error", reject);
        });
        assert.equal(status, 403, JSON.stringify(headers));
    }
    assert.equal(providerCalls, 0);
    const headers = { "X-Pokemon-Flipper": "1", Origin: base };
    assert.equal((await fetch(base + "/api/sniper", { headers })).status, 200);
    assert.equal(providerCalls, 1);
});
