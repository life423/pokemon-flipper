import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { localApi, validSearchRequest } from "../../server/lib/local-api.ts";
test("untrusted websites, simple GETs and invalid search values cannot reach provider work; local UI/CLI requests still work", async t => {
    const app = express(); let providerCalls = 0;
    app.use("/api", localApi); app.use(express.json());
    app.get("/api/deals", validSearchRequest, (_req, res) => { providerCalls++; res.json({ ok: true }); });
    app.post("/api/deals/new", validSearchRequest, (_req, res) => { providerCalls++; res.json({ ok: true }); });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    for (const headers of [{}, { "X-Pokemon-Flipper": "1", Origin: "https://untrusted.example" }, { "X-Pokemon-Flipper": "1", Host: "rebound.example" }, { "X-Pokemon-Flipper": "1", "Sec-Fetch-Site": "cross-site" }] as Record<string, string>[]) {
        const status = await new Promise<number | undefined>((resolve, reject) => {
            const request = http.get(base + "/api/deals?q=charizard", { headers }, response => { response.resume(); response.on("end", () => resolve(response.statusCode)); }); request.on("error", reject);
        });
        assert.equal(status, 403, JSON.stringify(headers));
    }
    assert.equal(providerCalls, 0);
    const headers = { "X-Pokemon-Flipper": "1", Origin: base };
    for (const query of ["", "?q=", "?q=%20", "?q=" + "a".repeat(301), "?q=charizard&min=Infinity", "?q=charizard&min=-1", "?q=charizard&max=0", "?q=charizard&roi=NaN"]) assert.equal((await fetch(base + "/api/deals" + query, { headers })).status, 400);
    assert.equal(providerCalls, 0);
    assert.equal((await fetch(base + "/api/deals?q=charizard&profit=0&roi=0&min=0&max=400", { headers })).status, 200);
    assert.equal((await fetch(base + "/api/deals/new", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ query: "new holo cards" }) })).status, 200);
    assert.equal(providerCalls, 2);
});
