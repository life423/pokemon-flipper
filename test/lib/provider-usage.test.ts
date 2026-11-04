import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createProviderUsageMonitor } from "../../server/lib/provider-usage.ts";

const START = Date.UTC(2026, 10, 4, 12);
const observation = (at: number, remaining = 20000, limit = 20000, reset = START + 12 * 3600000) =>
    ({ limit, remaining, observedAt: new Date(at).toISOString(), resetsAt: new Date(reset).toISOString() });
async function fixture(t: any) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pokemon-provider-usage-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    let at = START;
    return { directory, now: () => at, advance: (ms: number) => { at += ms; },
        monitor: createProviderUsageMonitor({ directory, now: () => at }) };
}

test("quota observations survive restart, share an account across searches, and warn on a five-percent burst", async t => {
    const h = await fixture(t);
    await h.monitor.record("PKMNPRICES", "private-provider-key", observation(h.now()));
    assert.equal((await h.monitor.read("PKMNPRICES", "private-provider-key"))!.usedInWindow, null);
    h.advance(5000);
    await h.monitor.record("PKMNPRICES", "private-provider-key", observation(h.now(), 19000));
    const restarted = createProviderUsageMonitor({ directory: h.directory, now: h.now });
    const snapshot = await restarted.read("PKMNPRICES", "private-provider-key");
    assert.equal(snapshot!.usedInWindow, 1000);
    assert.equal(snapshot!.warning, "FAST");
    assert.equal(snapshot!.windowMinutes, 5 / 60);
    assert.equal(await restarted.read("PKMNPRICES", "different-account"), null);
    const files = await fs.readdir(h.directory);
    assert.equal(files.length, 1);
    assert.ok(!files[0].includes("private-provider-key"));
    assert.ok(!(await fs.readFile(path.join(h.directory, files[0]), "utf8")).includes("private-provider-key"));
});

test("low and rapid-use warnings combine while tiny normal changes stay quiet", async t => {
    const h = await fixture(t);
    await h.monitor.record("EBAY", "account", observation(h.now(), 1100, 5000));
    h.advance(1000);
    await h.monitor.record("EBAY", "account", observation(h.now(), 1000, 5000));
    assert.equal((await h.monitor.read("EBAY", "account"))!.warning, "LOW");
    h.advance(1000);
    await h.monitor.record("EBAY", "account", observation(h.now(), 800, 5000));
    assert.equal((await h.monitor.read("EBAY", "account"))!.warning, "LOW_AND_FAST");
    await h.monitor.record("PKMNPRICES", "account", observation(h.now(), 19999));
    h.advance(1000);
    await h.monitor.record("PKMNPRICES", "account", observation(h.now(), 19998));
    assert.equal((await h.monitor.read("PKMNPRICES", "account"))!.warning, null);
});

test("old observations and same-period balance increases cannot erase a burst; reset countdown jitter is comparable", async t => {
    const h = await fixture(t);
    await h.monitor.record("PKMNPRICES", "account", observation(h.now(), 20000));
    h.advance(60000);
    await h.monitor.record("PKMNPRICES", "account", observation(h.now(), 18000, 20000, START + 12 * 3600000 + 1000));
    await h.monitor.record("PKMNPRICES", "account", observation(START, 19500));
    await h.monitor.record("PKMNPRICES", "account", observation(h.now(), 19000));
    const snapshot = await h.monitor.read("PKMNPRICES", "account");
    assert.equal(snapshot!.remaining, 18000);
    assert.equal(snapshot!.usedInWindow, 2000);
    assert.equal(snapshot!.warning, "FAST");
});

test("new quota/reset periods start a new baseline and expired, stale or future data do not claim current balance", async t => {
    const h = await fixture(t);
    await h.monitor.record("PKMNPRICES", "account", observation(h.now(), 100));
    h.advance(12 * 3600000);
    assert.equal(await h.monitor.read("PKMNPRICES", "account"), null);
    await h.monitor.record("PKMNPRICES", "account", observation(h.now(), 20000, 20000, h.now() + 24 * 3600000));
    let snapshot = await h.monitor.read("PKMNPRICES", "account");
    assert.equal(snapshot!.remaining, 20000);
    assert.equal(snapshot!.usedInWindow, null);
    await h.monitor.record("PKMNPRICES", "account", observation(h.now() + 60000, 1, 20000, h.now() + 24 * 3600000));
    snapshot = await h.monitor.read("PKMNPRICES", "account");
    assert.equal(snapshot!.remaining, 20000);
    h.advance(15 * 60000 + 1);
    assert.equal(await h.monitor.read("PKMNPRICES", "account"), null);
});

test("minutely first and last observations keep a fifteen-minute history bounded without losing within-minute bursts", async t => {
    const h = await fixture(t);
    for (let i = 0; i <= 960; i++) {
        await h.monitor.record("PKMNPRICES", "account", observation(h.now(), 20000 - i));
        h.advance(1000);
    }
    const file = path.join(h.directory, (await fs.readdir(h.directory))[0]);
    const ledger = JSON.parse(await fs.readFile(file, "utf8"));
    assert.ok(ledger.samples.length <= 34);
    const minutes = new Map<number, number>();
    for (const sample of ledger.samples) {
        const minute = Math.floor(Date.parse(sample.observedAt) / 60000);
        minutes.set(minute, (minutes.get(minute) ?? 0) + 1);
    }
    assert.ok([...minutes.values()].every(count => count <= 2));
    assert.ok((await h.monitor.read("PKMNPRICES", "account"))!.windowMinutes <= 15);
});

test("local reads never create files or call providers and corrupt/unwritable telemetry stays unavailable", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("quota monitoring must not poll providers"));
    const h = await fixture(t);
    assert.equal(await h.monitor.read("EBAY", "account"), null);
    assert.deepEqual(await fs.readdir(h.directory), []);
    await assert.rejects(h.monitor.record("EBAY", "account", { ...observation(h.now()), remaining: -1 }), /Invalid/);
    await h.monitor.record("EBAY", "account", observation(h.now(), 5000, 5000));
    const file = path.join(h.directory, (await fs.readdir(h.directory))[0]);
    await fs.writeFile(file, "{}");
    assert.equal(await h.monitor.read("EBAY", "account"), null);
    await assert.rejects(h.monitor.record("EBAY", "account", observation(h.now(), 4900, 5000)), /Invalid/);
    assert.equal(await fs.readFile(file, "utf8"), "{}", "corrupt history is preserved");
    const blocked = createProviderUsageMonitor({ directory: file, now: h.now });
    await assert.rejects(blocked.record("EBAY", "account", observation(h.now(), 4900, 5000)));
    assert.equal(await blocked.read("EBAY", "account"), null);
});

test("a monitoring write failure cannot retry an accepted eBay response or block its Browse reservation", async t => {
    const h = await fixture(t);
    await fs.writeFile(path.join(h.directory, "provider-usage"), "block telemetry directory");
    const source = `
        import assert from 'node:assert/strict';
        import { ebayUsage, reserveBrowseRequest } from './server/ebay/usage.ts';
        let oauth = 0, analytics = 0;
        globalThis.fetch = async input => {
            const url = String(input);
            if (url.includes('/identity/v1/oauth2/token')) { oauth++; return Response.json({ access_token: 'offline', expires_in: 3600 }); }
            assert.ok(url.includes('/developer/analytics/'));
            analytics++;
            return Response.json({ rateLimits: [{ apiName: 'Browse', resources: [{ name: 'buy.browse', rates: [
                { count: 10, limit: 5000, remaining: 4990, reset: new Date(Date.now() + 3600000).toISOString() }
            ] }] }] });
        };
        assert.equal((await ebayUsage({ fresh: true })).remaining, 4990);
        await reserveBrowseRequest();
        assert.equal(oauth, 1);
        assert.equal(analytics, 1);
    `;
    await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
        cwd: process.cwd(), env: { ...process.env, POKEMON_FLIPPER_DATA_DIR: h.directory, POKEMON_FLIPPER_STORAGE: "file",
            EBAY_CLIENT_ID: `offline-provider-monitor-failure-${path.basename(h.directory)}`, EBAY_CLIENT_SECRET: "offline-secret" },
    });
    assert.equal(await fs.readFile(path.join(h.directory, "provider-usage"), "utf8"), "block telemetry directory");
});
