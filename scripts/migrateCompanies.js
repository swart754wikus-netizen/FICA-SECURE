// One-time migration for the pre-existing `fica-app-fc93c` project: converts
// COMPANIES documents from the v1 plaintext `accessCode`/`agentPassword`
// fields to the v2 `accessCodeHash`/`agentPasswordHash` fields, then deletes
// the plaintext fields.
//
// Usage:
//   FIREBASE_PROJECT_ID=... FIREBASE_CLIENT_EMAIL=... FIREBASE_PRIVATE_KEY=... \
//     node scripts/migrateCompanies.js rotate   # issue brand-new codes (recommended — see README)
//   ...  node scripts/migrateCompanies.js rehash  # keep existing codes, just hash them
//
// "rotate" is the safer choice: this project's plaintext credentials were
// exposed to unauthenticated Firestore reads, so anyone who already scraped
// them has valid codes today regardless of how they're stored going forward.
// Re-hashing the same values without rotating does not revoke that exposure.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const admin = require('firebase-admin');

const mode = process.argv[2];
if (mode !== 'rotate' && mode !== 'rehash') {
  console.error('Usage: node scripts/migrateCompanies.js <rotate|rehash>');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  }),
});
const db = admin.firestore();

function randomCode(len = 8) {
  return crypto.randomBytes(len).toString('base64url').slice(0, len).toUpperCase();
}

async function main() {
  const snap = await db.collection('COMPANIES').get();
  if (snap.empty) {
    console.log('No COMPANIES documents found.');
    return;
  }

  const issued = [];

  for (const docSnap of snap.docs) {
    const company = docSnap.data();
    const plainAccessCode = mode === 'rotate' ? randomCode() : company.accessCode;
    const plainAgentPassword = mode === 'rotate' ? randomCode(10) : company.agentPassword;

    if (!plainAccessCode || !plainAgentPassword) {
      console.warn(`Skipping ${docSnap.id} (${company.name}) — missing accessCode/agentPassword to migrate.`);
      continue;
    }

    const accessCodeHash = await bcrypt.hash(plainAccessCode, 10);
    const agentPasswordHash = await bcrypt.hash(plainAgentPassword, 10);

    await docSnap.ref.update({
      accessCodeHash,
      agentPasswordHash,
      accessCode: admin.firestore.FieldValue.delete(),
      agentPassword: admin.firestore.FieldValue.delete(),
    });

    if (mode === 'rotate') {
      issued.push({ slug: company.slug, name: company.name, accessCode: plainAccessCode, agentPassword: plainAgentPassword });
    }
    console.log(`Migrated ${docSnap.id} (${company.name})`);
  }

  if (mode === 'rotate' && issued.length) {
    console.log('\nNEW CREDENTIALS — distribute these to each agency, then discard this output:\n');
    issued.forEach((c) => {
      console.log(`${c.name} (${c.slug}): access code = ${c.accessCode} | agent password = ${c.agentPassword}`);
    });
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
