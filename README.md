# Yumm HR — secure server edition

A server-backed rewrite of the HR tool, built so it can be safely hosted in the
cloud. Unlike the old single-file version, **no employee data lives in the
browser or in the HTML** — the browser holds only a session cookie and shows
what the logged-in user is authorised to see.

## Why the rewrite was necessary

The old `Yumm HR Tool.html` embedded all 81 employees (names, salaries, phone
numbers), the company GSTIN/PAN, and stored bank + Aadhaar/PAN scans unencrypted
in the browser. Its login was client-side JavaScript, bypassable in one line.
Hosting that file publicly would have leaked everything. None of that is fixable
by editing the file — the data and the auth have to move to a server.

## Security controls (all verified by `npm test`)

| Area | Control |
|---|---|
| Passwords | bcrypt (cost 12); min 10 chars; blocks common/username-containing passwords |
| Brute force | Account locks for 15 min after 5 fails; per-IP login rate limit |
| Sessions | Opaque random token in an **httpOnly, SameSite=strict, Secure** cookie; only its SHA-256 is stored; 8 h expiry (14 d if "remember"); revoked on password change |
| Authorization | Roles `admin` / `hr` / `viewer`, enforced **server-side** on every route |
| Data leakage | `viewer` never receives bank account numbers (field omitted, not blanked) |
| Data at rest | Bank numbers + **all KYC file bytes** encrypted with AES-256-GCM |
| File uploads | MIME allow-list checked against real **magic bytes**; 8 MB cap; server-generated filenames; downloads forced to `attachment` + sandbox CSP + `nosniff` |
| CSRF | SameSite cookie + Origin check + required `X-Requested-With` header |
| Injection | Parameterised SQL everywhere; Zod validation on all input |
| Transport/headers | Helmet CSP (no inline scripts), HSTS in prod, no `x-powered-by` |
| Accountability | Append-only audit log of every mutation and every KYC download |
| Errors | Central handler; no stack traces or SQL reach the client |

## Folder structure

```
yumm-hr-app/
├── src/
│   ├── server.js            # entry point (binds 0.0.0.0:$PORT)
│   ├── app.js               # Express app: middleware, CSRF, routes, auth endpoints
│   ├── auth.js              # bcrypt, sessions, lockout, RBAC
│   ├── crypto.js            # AES-256-GCM at rest, token hashing
│   ├── db.js                # SQLite schema + audit log
│   ├── routes/              # employees, kyc, company, advances, payroll, users, admin
│   └── services/            # payroll (money math), import (legacy migration)
├── public/                  # frontend SPA — no PII, strict-CSP, no inline scripts
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── scripts/
│   ├── init-admin.js        # create the first admin (npm run init-admin)
│   └── import-legacy.js     # CLI migration (npm run import-legacy -- backup.json)
├── test/                    # security.test.js + domain.test.js (26 tests)
├── data/                    # SQLite DB + KYC files — git-ignored, on a volume in prod
├── legacy-data/             # local migration backups (PII) — git-ignored
├── railway.json  nixpacks.toml  Procfile  .nvmrc   # deployment
├── .env  .env.example       # .env is git-ignored
└── package.json
```

## Environment variables

| Variable | Required | Example / default | Notes |
|---|---|---|---|
| `APP_ENC_KEY` | **yes** | base64 of 32 random bytes | Encrypts bank numbers + KYC files. Back it up; never commit it. |
| `NODE_ENV` | prod | `production` | Enables Secure cookies + HSTS. |
| `PORT` | auto | `3000` | Railway injects this — don't set it there. |
| `DB_FILE` | yes | `/data/yumm-hr.db` | Put on the Railway volume. Locally `./data/yumm-hr.db`. |
| `KYC_DIR` | yes | `/data/kyc` | Encrypted KYC files. On the volume in prod. |
| `HOST` | no | `0.0.0.0` | Bind address. |
| `LOGIN_RATE_MAX` | no | `10` | Login attempts per IP / 15 min. |
| `API_RATE_MAX` | no | `300` | API requests per IP / min. |

Generate the key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## First-time setup

```bash
cd yumm-hr-app
npm install

# 1. Create the environment file and a 32-byte encryption key
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
#    -> paste the output as APP_ENC_KEY in .env

# 2. Create the first admin account (password typed at the prompt, not on the CLI)
npm run init-admin

# 3. (optional) migrate old data: download a Backup JSON from the old app first
npm run import-legacy -- "../Yumm_HR_Backup_2026-07-10.json"

# 4. Run
npm start        # http://127.0.0.1:3000
```

> **Keep `APP_ENC_KEY` safe and backed up.** If it is lost, every encrypted bank
> number and KYC file becomes permanently unreadable. If it leaks, so does that
> data. It must never be committed — `.env` and `data/` are git-ignored.

## Tests

```bash
node --test test/security.test.js
```

16 adversarial tests: login/lockout, RBAC, viewer data-scoping, CSRF, encryption
at rest, input validation, security headers, and error non-disclosure.

## What's included

- **Full API**: auth, employees, KYC, company, advances, payroll, users — all
  role-guarded, validated, and audited.
- **Frontend** (`public/`): a single-page app served by the same server. It
  talks only to the API, holds no PII in its source, and runs under a strict CSP
  (no inline scripts). Dashboard, Employees, Payroll, Advances, Company, Users,
  KYC upload, and Word letterhead reports.
- **Tests**: `test/security.test.js` (16) + `test/domain.test.js` (8), all green.

## Deploying to Railway

Railway builds with Nixpacks (Node 24 is pinned in `nixpacks.toml`), runs
`node src/server.js`, injects `PORT`, and terminates HTTPS at its edge — which is
why the session cookie is `Secure` in production.

1. **Push this folder to a Git repo** (GitHub/GitLab). `.env` and `data/` are
   git-ignored, so no secrets or data are committed.
2. **New Project → Deploy from repo** on [railway.app](https://railway.app),
   pointing at `yumm-hr-app/` (set it as the root/service directory).
3. **Add a Volume** (Storage → Add Volume) mounted at **`/data`**. SQLite and
   KYC files live here; without a volume they'd be wiped on every redeploy.
4. **Set environment variables** (Variables tab):

   | Variable | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `APP_ENC_KEY` | output of `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
   | `DB_FILE` | `/data/yumm-hr.db` |
   | `KYC_DIR` | `/data/kyc` |

   `PORT` is provided by Railway automatically — do not set it.
5. **Deploy.** The healthcheck at `/api/health` gates the release.
6. **Create the first admin.** Open the service shell (Railway → your service →
   the `⋮` / “Shell”) and run:
   ```bash
   npm run init-admin
   ```
7. Visit the generated `*.up.railway.app` URL and sign in.
8. **Migrate your data (no PII in the repo).** In the old single-file app click
   **⬇ Backup** to download its JSON. In the new app go to **🔐 Users →
   📥 Import legacy data**, pick that file, and import. The 81 employees +
   company profile load straight into the database over HTTPS. (KYC scans aren’t
   in the backup — re-upload them per employee via the 📎 button.)

### After go-live

- **Back up the volume** on a schedule (`/data/yumm-hr.db` + `/data/kyc`). Store
  `APP_ENC_KEY` in a password manager — the KYC/bank data is unrecoverable
  without it, and readable by anyone who has it.
- Add a **custom domain** in Railway if you want (HTTPS is automatic).
- Rotate the admin password after first login; create `hr` / `viewer` users
  rather than sharing the admin account.

## Compliance note (India)

You store Aadhaar/PAN scans and bank details. Under the **DPDP Act 2023** this is
personal data with breach-notification duties, and UIDAI rules restrict storing
Aadhaar copies. Encryption + access control + the audit log are necessary
groundwork, but confirm your retention and consent obligations before go-live.
```
