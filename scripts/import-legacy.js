/**
 * Migrate data out of the old single-file app into the secure database.
 *
 * In the OLD app, click ⬇ Backup to download the JSON, then:
 *   node scripts/import-legacy.js path/to/Yumm_HR_Backup.json [--replace]
 */
import "dotenv/config";
import fs from "node:fs";
import { openDb } from "../src/db.js";
import { loadKey } from "../src/crypto.js";
import { importLegacy } from "../src/services/import.js";

const file = process.argv[2];
const replace = process.argv.includes("--replace");
if (!file) { console.error("Usage: node scripts/import-legacy.js <backup.json> [--replace]"); process.exit(1); }

loadKey();
const db = openDb();
try {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const { employees, advances } = importLegacy(db, data, { replace });
  console.log(`✓ Imported ${employees} employees and ${advances} advances. Bank numbers encrypted.`);
  console.log("  Re-upload KYC documents through the new app (they were not in the backup).");
  process.exit(0);
} catch (e) {
  console.error("Import failed:", e.message);
  process.exit(1);
}
