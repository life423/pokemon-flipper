import fs from "node:fs/promises";
import { writeJsonAtomic } from "./atomic-json.ts";

// Serialize read/modify/write operations and replace atomically. A corrupt file
// is an error, never permission to erase saved user data.
export function jsonStore<T>(file: string, initial: () => T, valid: (value: unknown) => value is T) {
    let tail = Promise.resolve();
    const read = async (): Promise<T> => {
        try {
            const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
            if (!valid(value)) throw new Error("Invalid saved data");
            return value;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return initial();
            throw new Error("Saved data could not be read. The existing file was kept.", { cause: error });
        }
    };
    return {
        read: async () => { await tail; return read(); },
        change<R>(edit: (value: T) => R): Promise<R> {
            const operation = tail.then(async () => {
                const value = await read();
                const before = JSON.stringify(value);
                const result = edit(value);
                if (JSON.stringify(value) === before) return result;
                await writeJsonAtomic(file, value);
                return result;
            });
            tail = operation.then(() => {}, () => {});
            return operation;
        },
    };
}
