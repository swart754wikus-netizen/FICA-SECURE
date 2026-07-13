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

`firestore.rules`/`storage.rules` already have your super admin email (`swart754wikus@gmail.com`) filled in. Paste each file's contents into Firebase Console → Firestore Database → Rules, and → Storage → Rules, then Publish (this replaces the emergency deny-all from step 0).

(Firebase CLI alternative: `firebase deploy --only firestore:rules,storage:rules --project fica-app-fc93c`.)

### 4. Vercel

1. Import this repo at vercel.com/new.
2. Project Settings → Environment Variables — set (see `.env.example`, project ID and storage bucket are already filled in there):
   - `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` — from the service account JSON from step 1. `FIREBASE_PRIVATE_KEY` must keep its `\n` escapes; paste it exactly as it appears in the JSON's `private_key` field.
   - `FIREBASE_STORAGE_BUCKET` = `fica-app-fc93c.firebasestorage.app`
   - `SUPER_ADMIN_EMAIL` = `swart754wikus@gmail.com`
3. Deploy.

### 5. Verify, then tell your agencies

Log into `/superadmin` with your existing Firebase Auth account. Existing companies should show up (their submissions are untouched). If you ran `rotate`, distribute each agency's new access code/agent password from the script's output, and update the client links you've sent out if slugs changed (they didn't — only credentials did).

## Verification checklist

- `GET` `https://firestore.googleapis.com/v1/projects/<project>/databases/(default)/documents/COMPANIES?key=<apiKey>` unauthenticated — must return a permission error, not data.
- Same for `FICA_SUBMISSIONS`.
- `checkClientAccessCode` / `agentLogin` with a wrong code/password — rejected, generic message, no hint whether the slug/company exists.
- 8 consecutive wrong attempts for the same slug — 9th attempt returns 429 (locked out) even with the correct credential.
- `agentLogin` against a `suspended` company — rejected.
- Client login → submit with a file attached → confirm the file exists in Storage under `submissions/{companyId}/{submissionId}/...` and the Firestore doc's `attachments` field has a working URL.
- As an agent for Company A, try to read a Company B submission by ID directly via the client SDK — denied by rules.
- Confirm the UI never renders `accessCodeHash`/`agentPasswordHash` anywhere.
