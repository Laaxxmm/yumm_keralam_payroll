/** Admin-only user management. */
import { Router } from "express";
import { z } from "zod";
import { getDb, audit } from "../db.js";
import { createUser, hashPassword, validatePassword, destroyAllSessionsFor } from "../auth.js";

const router = Router();

router.get("/", (_req, res) => {
  const rows = getDb()
    .prepare("SELECT id, username, role, must_change, last_login, locked_until, created_at FROM users ORDER BY id")
    .all();
  res.json({ users: rows.map((u) => ({ ...u, locked: !!u.locked_until && u.locked_until > Date.now() })) });
});

const NewUser = z.object({
  username: z.string().trim().min(3).max(40).regex(/^[a-zA-Z0-9_.\-]+$/, "Letters, numbers, . _ - only"),
  password: z.string().min(1),
  role: z.enum(["admin", "hr", "viewer"]),
});

router.post("/", async (req, res) => {
  const parsed = NewUser.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { username, password, role } = parsed.data;
  if (getDb().prepare("SELECT id FROM users WHERE username=?").get(username))
    return res.status(409).json({ error: "Username already exists." });
  const pwErr = validatePassword(password, username);
  if (pwErr) return res.status(400).json({ error: pwErr });
  try {
    const id = await createUser({ username, password, role, mustChange: 1 });
    audit(req, "user.create", "user", id, `${username}/${role}`);
    res.status(201).json({ id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/:id/reset-password", async (req, res) => {
  const id = Number(req.params.id);
  const u = getDb().prepare("SELECT username FROM users WHERE id=?").get(id);
  if (!u) return res.status(404).json({ error: "User not found." });
  const pw = String(req.body?.password ?? "");
  const err = validatePassword(pw, u.username);
  if (err) return res.status(400).json({ error: err });
  getDb().prepare("UPDATE users SET pass_hash=?, must_change=1, failed_count=0, locked_until=NULL WHERE id=?")
    .run(await hashPassword(pw), id);
  destroyAllSessionsFor(id);
  audit(req, "user.reset_password", "user", id);
  res.json({ ok: true });
});

router.put("/:id/role", (req, res) => {
  const id = Number(req.params.id);
  const role = req.body?.role;
  if (!["admin", "hr", "viewer"].includes(role)) return res.status(400).json({ error: "Bad role." });
  if (id === req.user.id) return res.status(400).json({ error: "You cannot change your own role." });
  const info = getDb().prepare("UPDATE users SET role=? WHERE id=?").run(role, id);
  if (!info.changes) return res.status(404).json({ error: "User not found." });
  audit(req, "user.role_change", "user", id, role);
  res.json({ ok: true });
});

router.delete("/:id", (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "You cannot delete yourself." });
  const admins = getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get().n;
  const target = getDb().prepare("SELECT role FROM users WHERE id=?").get(id);
  if (!target) return res.status(404).json({ error: "User not found." });
  if (target.role === "admin" && admins <= 1)
    return res.status(400).json({ error: "Cannot delete the last admin." });
  getDb().prepare("DELETE FROM users WHERE id=?").run(id);
  audit(req, "user.delete", "user", id);
  res.json({ ok: true });
});

export default router;
