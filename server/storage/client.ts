import sql from "mssql";
import { AzureCliCredential, DefaultAzureCredential } from "@azure/identity";
import { StorageUnavailableError, sqlSettings } from "./config.ts";

export type SqlValue = string | number | boolean | Date | null;
export interface SqlExecutor {
    query<T extends object = Record<string, unknown>>(text: string, parameters?: Record<string, SqlValue>): Promise<T[]>;
    transaction<T>(run: (executor: SqlExecutor) => Promise<T>): Promise<T>;
}

function requestExecutor(request: () => sql.Request, transaction: SqlExecutor["transaction"]): SqlExecutor {
    return {
        async query<T extends object>(text: string, parameters: Record<string, SqlValue> = {}) {
            const command = request();
            for (const [name, value] of Object.entries(parameters)) {
                if (!/^[a-z][a-z0-9_]*$/i.test(name)) throw new StorageUnavailableError("An invalid SQL parameter name was rejected.");
                if (value instanceof Date) command.input(name, sql.DateTime2(3), value);
                else if (typeof value === "number") command.input(name, sql.Float, value);
                else if (typeof value === "boolean") command.input(name, sql.Bit, value);
                else command.input(name, sql.NVarChar(sql.MAX), value);
            }
            try { return (await command.query<T>(text)).recordset ?? []; }
            catch (cause) { throw new StorageUnavailableError(undefined, { cause }); }
        },
        transaction,
    };
}

let poolPromise: Promise<sql.ConnectionPool> | undefined;
async function pool() {
    if (!poolPromise) {
        poolPromise = (async () => {
            const settings = sqlSettings();
            const credential = settings.auth === "azure-cli" ? new AzureCliCredential() : new DefaultAzureCredential();
            const connection = new sql.ConnectionPool({ server: settings.server, database: settings.database,
                authentication: { type: "token-credential", options: { credential } },
                options: { encrypt: true, trustServerCertificate: false, enableArithAbort: true, appName: "PokemonFlipper" },
                pool: { max: 3, min: 0, idleTimeoutMillis: 30_000 }, connectionTimeout: 20_000, requestTimeout: 60_000 });
            connection.on("error", () => { /* requests surface sanitized failures; never log credentials */ });
            try { return await connection.connect(); }
            catch (cause) { await connection.close().catch(() => {}); throw new StorageUnavailableError(undefined, { cause }); }
        })().catch(error => { poolPromise = undefined; throw error; });
    }
    return poolPromise;
}

export async function getSqlExecutor(): Promise<SqlExecutor> {
    const connection = await pool();
    const transact: SqlExecutor["transaction"] = async run => {
        const transaction = new sql.Transaction(connection);
        let started = false;
        try {
            await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE); started = true;
            const executor = requestExecutor(() => new sql.Request(transaction), async () => { throw new StorageUnavailableError("Nested storage transactions are not supported."); });
            const result = await run(executor);
            await transaction.commit(); started = false;
            return result;
        } catch (cause) {
            if (started) await transaction.rollback().catch(() => {});
            if (cause instanceof StorageUnavailableError) throw cause;
            throw new StorageUnavailableError(undefined, { cause });
        }
    };
    return requestExecutor(() => connection.request(), transact);
}

export async function closeDatabase() {
    const current = poolPromise; poolPromise = undefined;
    if (current) await (await current).close();
}
