import fs from "node:fs/promises";
import { readDocument, sqlDocument } from "./documents.ts";

export async function readDataFile(file: string): Promise<Buffer>;
export async function readDataFile(file: string, encoding: "utf8"): Promise<string>;
export async function readDataFile(file: string, encoding?: "utf8"): Promise<Buffer | string> {
    const body = sqlDocument(file) ? await readDocument(file) : await fs.readFile(file);
    return encoding ? body.toString(encoding) : body;
}
