export class StorageUnavailableError extends Error {
    readonly code = "STORAGE_UNAVAILABLE";
    constructor(message = "Saved evidence storage is unavailable. No replacement provider work was authorized.", options?: ErrorOptions) { super(message, options); }
}

export function storageBackend(): "file" | "azure-sql" {
    const backend = process.env.POKEMON_FLIPPER_STORAGE ?? "file";
    if (backend !== "file" && backend !== "azure-sql") throw new StorageUnavailableError("The configured storage backend is invalid; provider work is blocked.");
    return backend;
}

export function localOwner(): string {
    const owner = process.env.AZURE_SQL_OWNER_ID?.trim() || "local-owner";
    if (owner.length > 128) throw new StorageUnavailableError("The local storage owner ID is invalid.");
    return owner;
}

export function sqlSettings() {
    const server = process.env.AZURE_SQL_SERVER?.trim() ?? "";
    const database = process.env.AZURE_SQL_DATABASE?.trim() ?? "";
    if (!/^[a-z0-9][a-z0-9.-]+\.database\.windows\.net$/i.test(server) || !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(database)) {
        throw new StorageUnavailableError("AZURE_SQL_SERVER and AZURE_SQL_DATABASE must identify the Azure SQL database before storage can connect.");
    }
    const auth = process.env.AZURE_SQL_AUTH ?? "default";
    if (auth !== "default" && auth !== "azure-cli") throw new StorageUnavailableError("AZURE_SQL_AUTH must be default or azure-cli.");
    return { server, database, auth };
}
