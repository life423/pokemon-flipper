import type { SqlExecutor } from "./client.ts";
import { localOwner, StorageUnavailableError } from "./config.ts";

// Additive extension of the existing schema. Older clients can continue to use
// the same evidence tables while the two computers are upgraded independently.
export const diagnosticSchema = `
IF OBJECT_ID('dbo.SearchDiagnostics','U') IS NULL BEGIN
 CREATE TABLE dbo.SearchDiagnostics (
  owner_id nvarchar(128) NOT NULL, search_id uniqueidentifier NOT NULL,
  saved_at datetime2(3) NOT NULL, payload_json nvarchar(max) NOT NULL CHECK (ISJSON(payload_json)=1),
  CONSTRAINT PK_SearchDiagnostics PRIMARY KEY(owner_id,search_id));
 CREATE INDEX IX_SearchDiagnostics_recent ON dbo.SearchDiagnostics(owner_id,saved_at DESC,search_id);
END;`;

export function sqlSearchDiagnostics<T extends { searchId: string; savedAt: string }>(
    executor: SqlExecutor, validate: (entry: T) => void, owner = localOwner(),
) {
    type Row = { id: string; body: string };
    function parse(row: Row): T {
        try {
            const entry: T = JSON.parse(row.body);
            if (entry.searchId !== row.id.toLowerCase()) throw new Error("Search identity mismatch.");
            validate(entry);
            return entry;
        } catch (cause) { throw new StorageUnavailableError("The saved search diagnostic could not be read.", { cause }); }
    }
    async function get(db: SqlExecutor, id: string) {
        const [row] = await db.query<Row>("SELECT search_id AS id,payload_json AS body FROM dbo.SearchDiagnostics WHERE owner_id=@owner AND search_id=@id", { owner, id });
        return row ? parse(row) : null;
    }
    return {
        get: (id: string) => get(executor, id),
        async recent(since: Date, limit: number) {
            const rows = await executor.query<Row>(`SELECT TOP(CAST(@limit AS int)) search_id AS id,payload_json AS body FROM dbo.SearchDiagnostics
                WHERE owner_id=@owner AND saved_at>@since ORDER BY saved_at DESC, search_id`, { owner, since, limit });
            return rows.map(parse);
        },
        async edit<R>(id: string, since: Date, limit: number, change: (entries: T[]) => R) {
            return executor.transaction(async tx => {
                await tx.query(`DECLARE @rc int; EXEC @rc=sp_getapplock @Resource=@resource,@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=15000;
                    IF @rc<0 THROW 51000,'Search diagnostics are busy.',1;`, { resource: "search-diagnostics:" + owner });
                const old = await get(tx, id);
                const before = JSON.stringify(old);
                const items = old && Date.parse(old.savedAt) > since.getTime() ? [old] : [];
                const result = change(items);
                const entry = items[0];
                if (entry && JSON.stringify(entry) !== before) {
                    validate(entry);
                    await tx.query(`UPDATE dbo.SearchDiagnostics SET saved_at=@at,payload_json=@body WHERE owner_id=@owner AND search_id=@id;
                        IF @@ROWCOUNT=0 INSERT dbo.SearchDiagnostics(owner_id,search_id,saved_at,payload_json) VALUES(@owner,@id,@at,@body);
                        WITH ranked AS (SELECT saved_at,ROW_NUMBER() OVER(ORDER BY saved_at DESC,search_id) AS position FROM dbo.SearchDiagnostics WHERE owner_id=@owner)
                        DELETE FROM ranked WHERE saved_at<=@since OR position>@limit;`,
                        { owner, id, at: new Date(entry.savedAt), body: JSON.stringify(entry), since, limit });
                }
                return result;
            });
        },
    };
}
