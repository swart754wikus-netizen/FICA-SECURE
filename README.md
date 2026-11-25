# FICA Secure Portal

FICA (Financial Intelligence Centre Act) compliance portal for South African real estate agencies. Three portals: **super admin** (`/superadmin`), **agent** (`/agent`), **client** (`/`).

## Architecture

- **Firestore** — `COMPANIES` and `FICA_SUBMISSIONS` collections, data layer.
- **Firebase Storage** — client documents and agency logos.
- **Firebase Auth** — sessions via custom tokens (agent/client) and email/password (super admin).
- **Vercel serverless functions** (`/api`, Node.js + `firebase-admin`) — all credential verification. This replaces the Firebase Cloud Functions in the original spec so the whole app (frontend + server logic) deploys from one Vercel project and Firestore/Storage/Auth can stay on Firebase's free Spark plan (Cloud Functions v2 requires the paid Blaze plan; Vercel functions don't).
- **Static frontend** — plain HTML/ES modules, no build step, served by Vercel directly.

Credential verification (`bcrypt.compare`) happens only inside `/api` functions using the Admin SDK, which bypasses Firestore/Storage rules entirely. The browser never receives `accessCodeHash` or `agentPasswordHash` and never compares a typed value against a stored secret client-side — Firestore/Storage rules default-deny everything else. This is the exact fix for the v1 flaw (plaintext credentials fetched to and compared in the browser).

Security hardening added beyond the original brief: Firestore-backed rate limiting/lockout on `checkClientAccessCode` and `agentLogin` (`lib/rateLimit.js`), a deterministic custom-token `uid` scheme (`agent:<companyId>` / `client:<companyId>`), a `.create()`-based atomic slug-uniqueness check, Storage upload size/content-type limits, and a Storage rule that allows a client to re-upload (not just create) a document before submission without opening up arbitrary rewrites afterward.

## This is a migration, not a fresh project

`js/firebaseClient.js` and `firestore.rules`/`storage.rules` are already wired to the real, pre-existing Firebase project (`fica-app-fc93c`) that the v1 app used — the one whose plaintext `accessCode`/`agentPassword` fields were exposed. There is no new project to create. **The company data already in that project (real agencies, real client PII in `FICA_SUBMISSIONS`) stays put** — only the rules, the login path, and the COMPANIES credential fields change.

### 0. Stop the bleed (do this first, before anything else here)

Paste a deny-all Firestore rule into Console → Firestore Database → Rules for `fica-app-fc93c` right now — the v1 app's plaintext fields are readable by anyone until you do. This will break the old (v1) app immediately; that's the point.

### 1. Get a service account key

Firebase Console → `fica-app-fc93c` → Project settings → Service accounts → Generate new private key. You'll use this for both the migration script (step 2) and the Vercel env vars (step 4).

### 2. Migrate existing COMPANIES documents

Every company doc currently has plaintext `accessCode`/`agentPassword`. `scripts/migrateCompanies.js` converts them to `accessCodeHash`/`agentPasswordHash` and deletes the plaintext fields. Run it once (with the service account values as env vars — see the script header):

```
node scripts/migrateCompanies.js rotate
```

`rotate` issues brand-new codes/passwords per agency (printed once to the console for you to redistribute) instead of re-hashing the exposed originals — since those originals were already publicly readable, hashing them now doesn't undo that exposure. Use `rehash` instead only if you've decided the operational disruption of rotating isn't worth it for your situation.

### 3. Security rules

Super admin access is a Firebase custom claim (see "Upgrading to individual logins" below — run `scripts/grantSuperAdmin.js` first). Paste each file's contents into Firebase Console → Firestore Database → Rules, and → Storage → Rules, then Publish (this replaces the emergency deny-all from step 0).

(Firebase CLI alternative: `firebase deploy --only firestore:rules,storage:rules --project fica-app-fc93c`.)

### 4. Vercel

1. Import this repo at vercel.com/new.
2. Project Settings → Environment Variables — set (see `.env.example`, project ID and storage bucket are already filled in there):
   - `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` — from the service account JSON from step 1. `FIREBASE_PRIVATE_KEY` must keep its `\n` escapes; paste it exactly as it appears in the JSON's `private_key` field.
   - `FIREBASE_STORAGE_BUCKET` = `fica-app-fc93c.firebasestorage.app`
   - `DATA_ENCRYPTION_KEY` — 32 random bytes, base64 (encrypts agents' authenticator secrets). Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Keep it safe: losing it means every agent re-enrols their authenticator.
3. Deploy.

### 4.5 Storage CORS (needed for the agent portal's document downloads)

Firebase Storage buckets have no CORS configuration by default. The agent portal fetches documents via authenticated `getBytes()` calls (deliberately, instead of the bypass-prone `getDownloadURL()` link — see architecture notes above), and browsers block that unless the bucket explicitly allows the calling origin:

```
FIREBASE_PROJECT_ID=... FIREBASE_CLIENT_EMAIL=... FIREBASE_PRIVATE_KEY=... \
  node scripts/setStorageCors.js https://your-vercel-domain.vercel.app
```

Re-run this whenever you add a custom domain. Without it, document download buttons in the agent portal fail with a CORS error in the browser console (not a permissions error — the rules/auth are separately correct).

### 5. Verify, then tell your agencies

Log into `/superadmin` with your existing Firebase Auth account. Existing companies should show up (their submissions are untouched). If you ran `rotate`, distribute each agency's new access code/agent password from the script's output, and update the client links you've sent out if slugs changed (they didn't — only credentials did).

## Upgrading to individual logins, invites and company clients

What this adds:

- **Individual agent logins** (`/api/agentAuth`, `/api/manageAgents`): email + password + mandatory authenticator-app code (TOTP). Secrets are AES-256-GCM encrypted in `AGENTS` (never readable from a browser), codes can't be replayed, failed attempts are rate-limited per IP and per account. Principals manage their own team; GLS adds each agency's first principal from **Super admin → Edit → Team**. As soon as an agency has one individual login, its shared agent password stops working.
- **Sessions:** agent sessions end when the browser closes, after 20 minutes idle, and — enforced in the rules — 12 hours after sign-in at most. Client sessions are capped at 2 hours. Deactivating an agent revokes their session.
- **Per-client invite links** (`/api/clientInvite`): agents create a personal link (valid 7 days, single use) and send it by copy or WhatsApp. The link's SHA-256 is the submission ID, so the rules allow exactly one submission per link, and that client can only upload into their own folder. Agents can cancel pending links. The shared link + access code keeps working until the super admin unticks **"Allow the shared client link"** for that agency.
- **Company / CC client type** with director/shareholder/beneficial-owner questions, plus sensible document lists per client type (company, trust, partnership) when the agency hasn't configured its own.
- **Super admin is a custom claim**, not an email address — nobody can gain access by registering an account with your email, and the email is no longer in the public rules.
- A notice in the agent portal listing the FICA duties the portal doesn't perform (sanctions screening, RMCP risk rating, goAML reporting).

### Deploy order (do it in this order or you'll lock yourself out)

1. **Vercel env:** add `DATA_ENCRYPTION_KEY` for Production **and** Preview (same value — they share one Firebase project). Keep `SUPER_ADMIN_EMAIL` for now.
2. **Become super admin (no terminal needed):** while the *old* rules are still published, open `/superadmin` on the deployment (preview or production) and log in with your admin email and password. `api/claimSuperAdmin.js` converts that account to the `superAdmin` claim automatically. (Alternative: `node scripts/grantSuperAdmin.js <email>` with the service-account env vars.)
3. **Merge and deploy** to Vercel.
4. **Publish** `firestore.rules` and `storage.rules` (step 3 above). Sign out of `/superadmin` and back in to confirm it still works.
5. Optional: remove `SUPER_ADMIN_EMAIL` from Vercel to switch off step 2's automatic upgrade.
6. **Per agency:** Super admin → Edit → Team → add the principal with a temporary password and tell them by phone. On first login they set up their authenticator; they can then add their own agents. Until then the agency keeps working on the shared password.
7. When an agency is comfortable with personal invites, untick "Allow the shared client link".

Tests: `npm test` (API, no network needed) and `cd tests/rules && npm install && npm test` (security rules in the Firebase emulator, needs Java 11+).

## FICA record-keeping & EDD

- **Retention (FICA s22–s23):** submissions and their documents cannot be deleted by anyone for 5 years after `createdAt` (enforced in `firestore.rules` / `storage.rules`). After that only the super admin can purge them. The agent portal no longer has a delete button.
- **Immutable evidence:** client answers, signature and documents can't be edited by agents or the super admin. Clients can attach document metadata once, within an hour of submitting.
- **EDD is risk-based, not self-selected:** the "Enhanced Due Diligence" form is the agency's internal risk assessment, so clients can no longer choose it. `eddTriggers()` in `js/formDefinitions.js` flags EDD from the client's answers (PEP/DPIP/family, non-resident, foreign operations, cash ≥ R50k, cash/international payment, lottery source, outstanding Form 1). Agents complete the assessment in the agent portal; it is saved once, server-timestamped and locked.
- **Access log:** `AUDIT_LOG` (append-only) records submission views, document views and EDD sign-offs. Until agents have individual logins (next step), the actor is the shared agency login.

To deploy: publish both rules files (step 3 above), then deploy the frontend. Rules tests: `cd tests/rules && npm install && npm test` (needs Java 11+).

## Verification checklist

- `GET` `https://firestore.googleapis.com/v1/projects/<project>/databases/(default)/documents/COMPANIES?key=<apiKey>` unauthenticated — must return a permission error, not data.
- Same for `FICA_SUBMISSIONS`.
- `checkClientAccessCode` / `agentLogin` with a wrong code/password — rejected, generic message, no hint whether the slug/company exists.
- 8 consecutive wrong attempts for the same slug — 9th attempt returns 429 (locked out) even with the correct credential.
- `agentLogin` against a `suspended` company — rejected.
- Client login → submit with a file attached → confirm the file exists in Storage under `submissions/{companyId}/{submissionId}/...` and the Firestore doc's `attachments` field has a working URL.
- As an agent for Company A, try to read a Company B submission by ID directly via the client SDK — denied by rules.
- Confirm the UI never renders `accessCodeHash`/`agentPasswordHash` anywhere.
