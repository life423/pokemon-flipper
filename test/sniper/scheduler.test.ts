import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SniperArm, SniperQuote } from "../../shared/sniper.ts";
import { createSniperScheduler } from "../../server/sniper/scheduler.ts";

async function auction(t: TestContext) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pokemon-sniper-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, "queue.json");
    const end = Date.UTC(2026, 10, 24, 18);
    const clock = { time: end - 60_000 };
    const itemId = "v1|123456789012|0";
    const quote = (): SniperQuote => ({
        itemId, url: "https://www.sandbox.ebay.com/itm/123456789012", title: "Charmeleon PSA 9",
        checkedAt: new Date(clock.time).toISOString(), endTime: new Date(end).toISOString(),
        currentBid: 34.75, minimumBid: 35.75, shipping: 3.99, highBidder: false, buyerConnectionId: "buyer-a",
    });
    const submissions: Array<[string, number]> = [];
    const services = {
        file, now: () => clock.time, sandboxBuyerId: async () => "buyer-a", readQuote: async () => quote(),
        submitSandbox: async (id: string, max: number) => { submissions.push([id, max]); return "receipt-1"; },
    };
    const plan: SniperArm = { quote: quote(), maxBid: 36.77, leadSeconds: 10, mode: "sandbox" };
    return { file, clock, end, quote, plan, submissions, services };
}

test("a restarted scheduler checks the exact sandbox auction at the scheduled time and submits once across concurrent workers", async t => {
    const { clock, end, plan, submissions, services } = await auction(t);
    const first = createSniperScheduler(services);
    const job = await first.arm(plan);
    assert.equal((await first.arm(plan)).id, job.id);
    await assert.rejects(first.arm({ ...plan, maxBid: plan.maxBid + 1 }), /already/);
    const second = createSniperScheduler(services);
    await second.tick();
    assert.equal((await second.list())[0].status, "ARMED");
    clock.time = end - 10_000;
    await Promise.all([first.tick(), second.tick(), second.tick()]);
    assert.deepEqual(submissions, [[plan.quote.itemId, 36.77]]);
    assert.equal((await second.list())[0].status, "SUBMITTED");
    assert.match((await second.list())[0].message, /receipt-1/);
    await assert.rejects(second.arm(plan), /already/);
});

test("ceiling, time window, latest shipping, item identity and highest-bidder status are enforced", async t => {
    const { clock, end, quote, plan, submissions, services } = await auction(t);
    let override: Partial<SniperQuote> = {};
    const scheduler = createSniperScheduler({ ...services, readQuote: async () => ({ ...quote(), ...override }) });
    await assert.rejects(scheduler.arm({ ...plan, maxBid: 36.777 }), /cents/);
    await assert.rejects(scheduler.arm({ ...plan, quote: { ...quote(), endTime: new Date(end + 12 * 3600_000).toISOString() } }), /12 hours/);
    await assert.rejects(createSniperScheduler({ ...services, sandboxBuyerId: async () => null }).arm(plan), /unavailable/);
    for (const [delta, reason] of [
        [{ minimumBid: 36.78 }, /exceeds/], [{ minimumBid: null }, /minimum/], [{ shipping: 4.99 }, /Shipping increased/],
        [{ shipping: null }, /shipping/], [{ itemId: "v1|223456789012|0" }, /identity/], [{ highBidder: true }, /already leads/],
        [{ checkedAt: new Date(end - 41_000).toISOString() }, /stale/], [{ endTime: new Date(end + 1).toISOString() }, /ending time changed/],
    ] as const) {
        clock.time = end - 60_000;
        const job = await scheduler.arm(plan);
        override = delta;
        clock.time = end - 10_000;
        await scheduler.tick();
        const result = (await scheduler.list()).find(entry => entry.id === job.id)!;
        assert.equal(result.status, "SKIPPED");
        assert.match(result.message, reason);
    }
    assert.deepEqual(submissions, []);
});

test("a reminder checks the latest terms and never sends a bid", async t => {
    const { clock, end, plan, submissions, services } = await auction(t);
    let checks = 0;
    const scheduler = createSniperScheduler({ ...services, readQuote: async () => { checks++; return services.readQuote(); } });
    await scheduler.arm({ ...plan, mode: "reminder" });
    clock.time = end - 10_000;
    await scheduler.tick();
    await scheduler.tick();
    assert.equal(checks, 1);
    assert.equal((await scheduler.list())[0].status, "REMINDER");
    assert.deepEqual(submissions, []);
});

test("cancelling during the final quote or receiving a quote after close prevents submission", async t => {
    const { clock, end, plan, submissions, services } = await auction(t);
    const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
    const scheduler = createSniperScheduler({ ...services, readQuote: async () => { entered.resolve(); await resume.promise; return services.readQuote(); } });
    const job = await scheduler.arm(plan);
    clock.time = end - 10_000;
    const ticking = scheduler.tick();
    await entered.promise;
    await scheduler.cancel(job.id);
    resume.resolve();
    await ticking;
    assert.equal((await scheduler.list())[0].status, "CANCELLED");
    const later = createSniperScheduler({ ...services, readQuote: async () => { clock.time = end + 1; return services.readQuote(); } });
    clock.time = end - 60_000;
    await later.arm(plan);
    clock.time = end - 10_000;
    await later.tick();
    assert.equal((await later.list())[0].status, "SKIPPED");
    assert.deepEqual(submissions, []);
});

test("restarts after the dispatch window skip late jobs; ambiguous responses remain terminal", async t => {
    const { clock, end, plan, services } = await auction(t);
    let submits = 0;
    const scheduler = createSniperScheduler({ ...services, submitSandbox: async () => { submits++; throw new Error("lost response"); } });
    await scheduler.arm(plan);
    clock.time = end - 1_000;
    await createSniperScheduler(services).tick();
    assert.match((await scheduler.list())[0].message, /missed/);
    clock.time = end - 60_000;
    await scheduler.arm(plan);
    clock.time = end - 10_000;
    await scheduler.tick();
    const restarted = createSniperScheduler(services);
    await restarted.tick();
    assert.equal((await restarted.list())[0].status, "UNCERTAIN");
    await assert.rejects(restarted.arm(plan), /already/);
    assert.equal(submits, 1);
});

test("starting the service wakes a due job and exposes interrupted delivery to another process without retrying", async t => {
    const { clock, end, plan, services } = await auction(t);
    const submitted = Promise.withResolvers<void>(), response = Promise.withResolvers<void>();
    let attempts = 0;
    const scheduler = createSniperScheduler({ ...services, submitSandbox: async () => {
        attempts++; submitted.resolve(); await response.promise; return "receipt-2";
    } });
    t.after(() => scheduler.stop());
    await scheduler.arm(plan);
    clock.time = end - 10_000;
    await scheduler.start();
    // An unref'd server timer may exit naturally in a standalone test process.
    const timeout = setTimeout(() => submitted.reject(new Error("The scheduler did not wake.")), 2_000);
    try { await submitted.promise; } finally { clearTimeout(timeout); }
    const observer = createSniperScheduler(services);
    try {
        const interrupted = (await observer.list())[0];
        assert.equal(interrupted.status, "UNCERTAIN");
        await assert.rejects(observer.cancel(interrupted.id), /submitting/);
        await observer.tick();
        assert.deepEqual((await observer.list()).map(job => job.status), ["UNCERTAIN"]);
        assert.equal(attempts, 1);
    } finally { response.resolve(); }
    const { drainSharedWork } = await import("../../server/lib/shared-work.ts");
    assert.equal((await drainSharedWork({ timeoutMs: 2_000 })).complete, true);
    assert.equal((await observer.list())[0].status, "SUBMITTED");
});

test("an unreadable queue preserves the original file and prevents dispatch", async t => {
    const { file, clock, end, plan, submissions, services } = await auction(t);
    const scheduler = createSniperScheduler(services);
    await scheduler.arm(plan);
    await fs.writeFile(file, "{");
    clock.time = end - 10_000;
    await assert.rejects(scheduler.tick(), /Saved data/);
    assert.equal(await fs.readFile(file, "utf8"), "{");
    assert.deepEqual(submissions, []);
});

test("reconnecting a buyer or opening an unbound legacy queue cannot transfer a bid to another account", async t => {
    const { clock, end, file, plan, services, submissions } = await auction(t);
    let buyer: string | null = "buyer-a";
    const scheduler = createSniperScheduler({ ...services, sandboxBuyerId: async () => buyer });
    const first = await scheduler.arm(plan);
    const reminder = await scheduler.arm({ ...plan, mode: "reminder" });
    buyer = null;
    await scheduler.reconcileBuyerJobs();
    assert.equal((await scheduler.list()).find(job => job.id === first.id)?.status, "CANCELLED");
    assert.equal((await scheduler.list()).find(job => job.id === reminder.id)?.status, "ARMED");
    buyer = "buyer-b";
    await assert.rejects(scheduler.arm(plan), /changed/);
    buyer = "buyer-a";
    await scheduler.arm(plan);
    const persisted = JSON.parse(await fs.readFile(file, "utf8"));
    delete persisted.jobs[0].quote.buyerConnectionId;
    await fs.writeFile(file, JSON.stringify(persisted));
    clock.time = end - 10_000;
    await scheduler.tick();
    assert.equal((await scheduler.list())[0].status, "SKIPPED");
    assert.deepEqual(submissions, []);
});

test("changing buyers during the final quote prevents the capped bid", async t => {
    const { clock, end, plan, services, submissions } = await auction(t);
    let buyer = "buyer-a";
    const scheduler = createSniperScheduler({
        ...services, sandboxBuyerId: async () => buyer,
        readQuote: async (_id, _mode, _signal, _search, expectedBuyer) => {
            assert.equal(expectedBuyer, "buyer-a");
            buyer = "buyer-b";
            return services.readQuote();
        },
    });
    await scheduler.arm(plan);
    clock.time = end - 10_000;
    await scheduler.tick();
    assert.equal((await scheduler.list())[0].status, "SKIPPED");
    assert.deepEqual(submissions, []);
});

test("a rejected buyer grant during a final check cancels its later queued bids", async t => {
    const { clock, end, plan, services, submissions } = await auction(t);
    let buyer: string | null = "buyer-a";
    const scheduler = createSniperScheduler({
        ...services, sandboxBuyerId: async () => buyer,
        readQuote: async () => { buyer = null; throw new Error("Grant revoked"); },
    });
    const first = await scheduler.arm(plan);
    const second = await scheduler.arm({ ...plan, quote: {
        ...plan.quote, itemId: "v1|223456789012|0", endTime: new Date(end + 60_000).toISOString(),
    } });
    clock.time = end - 10_000;
    await scheduler.tick();
    const jobs = await scheduler.list();
    assert.equal(jobs.find(job => job.id === first.id)?.status, "SKIPPED");
    assert.equal(jobs.find(job => job.id === second.id)?.status, "CANCELLED");
    assert.deepEqual(submissions, []);
});
