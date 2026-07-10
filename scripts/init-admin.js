/**
 * One-time bootstrap: create the first admin user.
 *
 * The password is read from stdin (never from argv, which would land in the
 * shell history and in `ps` output).
 *
 *   npm run init-admin
 */
import "dotenv/config";
import readline from "node:readline";
import { openDb } from "../src/db.js";
import { createUser } from "../src/auth.js";
import { loadKey } from "../src/crypto.js";

function ask(question, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    if (hidden) {
      const onData = (ch) => {
        if (["\n", "\r", ""].includes(ch.toString())) process.stdin.removeListener("data", onData);
        else process.stdout.write("\x1b[2K\x1b[200D" + question + "*".repeat(rl.line.length));
      };
      process.stdin.on("data", onData);
    }
    rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write("\n"); resolve(a); });
  });
}

const main = async () => {
  loadKey();
  const db = openDb();

  const existing = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  if (existing > 0) {
    console.error(`\nRefusing to run: ${existing} user(s) already exist.`);
    console.error("Use the app's user management (or delete data/yumm-hr.db to start over).\n");
    process.exit(1);
  }

  console.log("\nCreate the first administrator account.\n");
  const username = (await ask("Username: ")).trim() || "admin";
  const password = await ask("Password: ", { hidden: true });
  const confirm = await ask("Confirm : ", { hidden: true });

  if (password !== confirm) { console.error("\nPasswords do not match.\n"); process.exit(1); }

  try {
    const id = await createUser({ username, password, role: "admin" });
    console.log(`\n✓ Admin "${username}" created (id ${id}). You can now start the server.\n`);
  } catch (e) {
    console.error("\n" + e.message + "\n");
    process.exit(1);
  }
  process.exit(0);
};

main();
