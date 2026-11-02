import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getSqlExecutor } from "../server/storage/client.ts";
import { assertSqlStorageReady, closeDatabase, getSqlRepositories, localOwner, storageBackend } from "../server/storage/index.ts";
import { cacheScope, storageHash } from "../server/storage/repositories.ts";
import { createSqlAiDispatch } from "../server/ai/sql-dispatch.ts";

// Live SQL canaries only: no eBay, price API or OpenAI requests. Every write
// has a unique diagnostic identity and is removed after the checks.
async function check() {
    assert.equal(storageBackend(), "azure-sql", "Set POKEMON_FLIPPER_STORAGE=azure-sql for this deliberate database check.");
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pokemon-sql-check-"));
    const nonce = randomUUID(), cacheKey = `diagnostic:${nonce}`, unknownKey = `diagnostic-unknown:${nonce}`;
    const scope = `diagnostic:${nonce}`, body = { model: "offline-diagnostic", diagnosticId: nonce };
    const responseHash = createHash("sha256").update(JSON.stringify([scope, body])).digest("hex");
    const responseKey = `ai-dispatch:v1:${responseHash}`;
    const previousFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = async () => { networkCalls++; throw new Error("Provider fetch is forbidden in database diagnostics."); };
    let db: Awaited<ReturnType<typeof getSqlExecutor>> | undefined;
    try {
        await assertSqlStorageReady();
        db = await getSqlExecutor();
        const [connection] = await db.query<{ encrypted: string; databaseName: string }>(
            "SELECT encrypt_option AS encrypted,DB_NAME() AS databaseName FROM sys.dm_exec_connections WHERE session_id=@@SPID");
        assert.equal(connection?.encrypted, "TRUE", "The Node SQL pool must use an encrypted connection.");
        assert.equal(connection.databaseName, process.env.AZURE_SQL_DATABASE);
        const first = await getSqlRepositories(), second = await getSqlRepositories();
        const timestamp = new Date().toISOString();
        await first.writeCacheEntry({ key: cacheKey, savedAt: timestamp, data: false });
        assert.deepEqual(await second.readCacheEntry(cacheKey), { key: cacheKey, savedAt: timestamp, data: false });

        let simulatedDispatches = 0;
        const send = async (beforeSend: () => Promise<void>) => {
            await beforeSend(); simulatedDispatches++;
            return Response.json({ status: "completed", id: `diagnostic-${nonce}`, output: [] });
        };
        const dispatchA = createSqlAiDispatch({ enabled: () => true, repository: async () => first, recoveryDirectory: directory, scope: () => scope });
        const dispatchB = createSqlAiDispatch({ enabled: () => true, repository: async () => second, recoveryDirectory: directory, scope: () => scope });
        const responses = await Promise.all([dispatchA(body, send), dispatchB(body, send)]);
        assert.equal(simulatedDispatches, 1, "Concurrent SQL task consumers must share one simulated provider dispatch.");
        assert.equal(await responses[0]!.text(), await responses[1]!.text());

        const inputHash = storageHash(unknownKey), owner = `diagnostic-${nonce}`;
        assert.equal((await first.claimTask({ key: unknownKey, type: "DIAGNOSTIC", inputHash, ownerId: owner })).claimed, true);
        await first.markTaskDispatched(unknownKey, owner);
        await db.query("UPDATE dbo.ResearchTasks SET lease_until=DATEADD(second,-1,SYSUTCDATETIME()) WHERE task_hash=@hash", { hash: storageHash(unknownKey) });
        const afterExpiry = await second.claimTask({ key: unknownKey, type: "DIAGNOSTIC", inputHash, ownerId: "diagnostic-other" });
        assert.equal(afterExpiry.claimed, false); assert.equal(afterExpiry.state, "DISPATCHED");
        await first.markTaskUnknown(unknownKey, owner);
        const unknown = await second.claimTask({ key: unknownKey, type: "DIAGNOSTIC", inputHash, ownerId: "diagnostic-other" });
        assert.equal(unknown.claimed, false); assert.equal(unknown.state, "UNKNOWN");
        assert.equal(networkCalls, 0);
        return { encryptedConnection: true, scalarCacheRoundTrip: true, concurrentConsumers: 2, simulatedDispatches,
            expiredDispatchedClaimRetained: true, unknownOutcomeRetained: true, providerRequests: networkCalls };
    } finally {
        globalThis.fetch = previousFetch;
        try {
            if (db) await db.query(`DELETE dbo.ResearchTasks WHERE task_hash IN (@responseHash,@unknownHash);
DELETE dbo.ProviderCache WHERE cache_hash=@cacheHash;`, {
                responseHash: storageHash(responseKey), unknownHash: storageHash(unknownKey),
                cacheHash: storageHash(JSON.stringify([cacheScope(cacheKey, localOwner()), cacheKey])),
            });
        } finally { await closeDatabase(); await fs.rm(directory, { recursive: true, force: true }); }
    }
}
try { console.log(JSON.stringify(await check(), null, 2)); }
catch (error) { console.error(error instanceof Error ? error.message : "Database checks failed."); process.exitCode = 1; }
