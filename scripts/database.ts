import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "../server/lib/paths.ts";
import { DataImportError } from "../server/storage-import/types.ts";
import { inspectLegacyData, latestSnapshot, loadSnapshot, prepareSnapshot, summarizeImport } from "../server/storage-import/source.ts";
import { importSnapshot, verifySnapshot } from "../server/storage-import/migrate.ts";

interface Arguments { command: "status" | "migrate" | "import" | "verify"; directory: string; ownerId: string; dryRun: boolean; snapshot?: string }
export function databaseArguments(args: string[]): Arguments {
    const command = args[0];
    if (!["status", "migrate", "import", "verify"].includes(command ?? "")) throw new DataImportError("Usage: npm run db -- status|migrate|import [--dry-run]|verify [--data-dir PATH] [--owner ID] [--snapshot PATH]");
    const result: Arguments = { command: command as Arguments["command"], directory: DATA_DIR, ownerId: process.env.AZURE_SQL_OWNER_ID?.trim() || "local-owner", dryRun: false };
    for (let index = 1; index < args.length; index++) {
        const flag = args[index];
        if (flag === "--dry-run") { result.dryRun = true; continue; }
        if (!["--data-dir", "--owner", "--snapshot"].includes(flag ?? "") || !args[index + 1] || args[index + 1]!.startsWith("--")) throw new DataImportError("Unknown database argument or missing value.");
        const value = args[++index]!;
        if (flag === "--data-dir") result.directory = path.resolve(value);
        else if (flag === "--owner") result.ownerId = value;
        else result.snapshot = path.resolve(value);
    }
    if (result.dryRun && result.command !== "import") throw new DataImportError("--dry-run is supported for import only.");
    if (result.snapshot && !["import", "verify"].includes(result.command)) throw new DataImportError("--snapshot is supported for import and verify only.");
    return result;
}

export async function runDatabaseCommand(args: string[], signal?: AbortSignal): Promise<unknown> {
    const options = databaseArguments(args);
    // Source-only inspection does not load a SQL driver, obtain a token, create
    // backup files, mutate source data, or invoke any market/AI provider module.
    if (options.command === "import" && options.dryRun) {
        if (options.snapshot) throw new DataImportError("A dry run inspects current source files; omit --snapshot.");
        const manifest = await inspectLegacyData(options.directory, options.ownerId, signal);
        return { dryRun: true, manifestId: manifest.id, ...summarizeImport(manifest), unchanged: ["source files", "database", "AI/eBay spending and quota ledgers"] };
    }
    const sql = await import("../server/storage/index.ts");
    try {
        if (options.command === "migrate") return await sql.migrateDatabase();
        if (options.command === "status") return await sql.databaseStatus();
        if (options.ownerId !== sql.localOwner()) throw new DataImportError("--owner must match AZURE_SQL_OWNER_ID so private caches and evaluations migrate to the same owner. Set the local owner configuration explicitly before importing.");
        const status = await sql.databaseStatus(), target = await sql.getSqlRepositories();
        if (options.command === "verify") {
            const snapshot = options.snapshot ?? await latestSnapshot(options.directory);
            if ((await loadSnapshot(snapshot)).ownerId !== options.ownerId) throw new DataImportError("The snapshot belongs to a different private owner. Configure that owner explicitly before verification.");
            const result = await verifySnapshot(snapshot, target, signal);
            if (result.missing || result.mismatched) throw new DataImportError(`Readback found ${result.missing} missing and ${result.mismatched} mismatched records.`);
            return { snapshot, ...result };
        }
        const snapshot = options.snapshot ?? await prepareSnapshot(await inspectLegacyData(options.directory, options.ownerId, signal), undefined, signal);
        if ((await loadSnapshot(snapshot)).ownerId !== options.ownerId) throw new DataImportError("The snapshot belongs to a different private owner. No evidence was imported.");
        let lastLog = 0;
        const result = await importSnapshot(snapshot, target, `${status.server}/${status.database}`, { signal, onProgress: progress => {
            if (Date.now() - lastLog >= 5000) { console.log(`Imported or retained ${progress.processed.toLocaleString()} records; provider calls: 0.`); lastLog = Date.now(); }
        } });
        return { snapshot, ...result, preservedLocalOnly: ["shortlist", "search history", "AI spending controls and ledger", "eBay usage and development allowance"] };
    } finally { await sql.closeDatabase(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const controller = new AbortController();
    const stop = () => controller.abort(new Error("Database command interrupted; originals and checkpoints remain available."));
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try { console.log(JSON.stringify(await runDatabaseCommand(process.argv.slice(2), controller.signal), null, 2)); }
    catch (error) { console.error(error instanceof Error ? error.message : "Database command failed."); process.exitCode = 1; }
    finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}
