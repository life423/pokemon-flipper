import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

// Import before server modules: paths.ts captures its directory on first load.
// Mock SDK requests must never become entries in the user's real usage ledger.
const previous = process.env.POKEMON_FLIPPER_DATA_DIR;
export const isolatedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pokemon-offline-test-"));
process.env.POKEMON_FLIPPER_DATA_DIR = isolatedDataDir;
after(() => {
    fs.rmSync(isolatedDataDir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.POKEMON_FLIPPER_DATA_DIR;
    else process.env.POKEMON_FLIPPER_DATA_DIR = previous;
});
