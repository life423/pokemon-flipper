import path from "node:path";

// Folders the server reads and writes, from the project root.
export const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const CLIENT_ROOT = path.join(ROOT, "client");
export const DATA_DIR = path.join(ROOT, "data");
