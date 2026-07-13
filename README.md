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

## One-time setup

### 1. Firebase project

1. Create a project at the Firebase Console.
2. **Firestore Database** → create in production mode (any region).
3. **Storage** → get started, production mode.
4. **Authentication** → Sign-in method → enable **Email/Password**.
5. **Authentication** → Users → add one user: your super admin email + a password. This is the *only* account allowed into `/superadmin`.
6. **Project settings → General → Your apps** → add a Web app. Copy the `firebaseConfig` object into `js/firebaseClient.js` (replace the `YOUR_...` placeholders). This config is public by design — it is not a secret.
7. **Project settings → Service accounts** → Generate new private key. Download the JSON.

### 2. Security rules

In `firestore.rules` and `storage.rules`, replace every `YOUR_SUPER_ADMIN_EMAIL_HERE` with your real super admin email (must exactly match the Auth user from step 1.5). Paste each file's contents into Firebase Console → Firestore Database → Rules, and → Storage → Rules, then Publish.

(If you prefer the Firebase CLI: `firebase deploy --only firestore:rules,storage:rules` after `firebase init` + `firebase use <project-id>`.)

### 3. Vercel

1. Import this repo at vercel.com/new.
2. Project Settings → Environment Variables — set (see `.env.example`):
   - `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` — from the service account JSON downloaded above. `FIREBASE_PRIVATE_KEY` must keep its `\n` escapes; paste it exactly as it appears in the JSON's `private_key` field.
   - `FIREBASE_STORAGE_BUCKET` — e.g. `your-project-id.appspot.com`.
   - `SUPER_ADMIN_EMAIL` — same address as step 1.5 / the rules files.
3. Deploy.

### 4. Create your first agency

Go to `https://<your-vercel-domain>/superadmin`, log in with the super admin account, and create a company. The client link shown on the agent dashboard after logging in as that agency is `https://<your-vercel-domain>/?company=<slug>`.

## Verification checklist

- `GET` `https://firestore.googleapis.com/v1/projects/<project>/databases/(default)/documents/COMPANIES?key=<apiKey>` unauthenticated — must return a permission error, not data.
- Same for `FICA_SUBMISSIONS`.
- `checkClientAccessCode` / `agentLogin` with a wrong code/password — rejected, generic message, no hint whether the slug/company exists.
- 8 consecutive wrong attempts for the same slug — 9th attempt returns 429 (locked out) even with the correct credential.
- `agentLogin` against a `suspended` company — rejected.
- Client login → submit with a file attached → confirm the file exists in Storage under `submissions/{companyId}/{submissionId}/...` and the Firestore doc's `attachments` field has a working URL.
- As an agent for Company A, try to read a Company B submission by ID directly via the client SDK — denied by rules.
- Confirm the UI never renders `accessCodeHash`/`agentPasswordHash` anywhere.
