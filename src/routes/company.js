import { Router } from "express";
import { z } from "zod";
import { getDb, audit } from "../db.js";
import { requireRole } from "../auth.js";

const router = Router();

const CompanySchema = z.object({
  name: z.string().trim().max(120).default(""),
  entityType: z.string().trim().max(80).default(""),
  contact: z.string().trim().max(120).default(""),
  mobile: z.string().trim().max(20).default(""),
  email: z.string().trim().max(120).default(""),
  addr1: z.string().trim().max(200).default(""),
  addr2: z.string().trim().max(200).default(""),
  city: z.string().trim().max(80).default(""),
  state: z.string().trim().max(80).default(""),
  pincode: z.string().trim().max(12).default(""),
  country: z.string().trim().max(80).default(""),
  gstin: z.string().trim().max(20).default(""),
  pan: z.string().trim().max(15).default(""),
  uid: z.string().trim().max(40).default(""),
  tagline: z.string().trim().max(120).default(""),
  logo: z.string().max(600_000).optional(), // data URI, optional
});

function toApi(r) {
  return {
    name: r.name, entityType: r.entity_type, contact: r.contact, mobile: r.mobile, email: r.email,
    addr1: r.addr1, addr2: r.addr2, city: r.city, state: r.state, pincode: r.pincode,
    country: r.country, gstin: r.gstin, pan: r.pan, uid: r.uid, tagline: r.tagline,
    logo: r.logo_b64 || null,
  };
}

router.get("/", (_req, res) => {
  const r = getDb().prepare("SELECT * FROM company WHERE id = 1").get();
  res.json({ company: toApi(r) });
});

router.put("/", requireRole("admin", "hr"), (req, res) => {
  const parsed = CompanySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const c = parsed.data;
  const cur = getDb().prepare("SELECT logo_b64 FROM company WHERE id=1").get();
  const logo = c.logo !== undefined ? c.logo : cur?.logo_b64 || null;
  getDb().prepare(
    `UPDATE company SET name=?,entity_type=?,contact=?,mobile=?,email=?,addr1=?,addr2=?,
       city=?,state=?,pincode=?,country=?,gstin=?,pan=?,uid=?,tagline=?,logo_b64=? WHERE id=1`
  ).run(
    c.name, c.entityType, c.contact, c.mobile, c.email, c.addr1, c.addr2, c.city, c.state,
    c.pincode, c.country, c.gstin, c.pan, c.uid, c.tagline, logo
  );
  audit(req, "company.update", "company", 1);
  res.json({ ok: true });
});

export default router;
