// Firebase Storage buckets have no CORS configuration by default. The
// client SDK's authenticated read calls (getBytes/getBlob — used by the
// agent portal to fetch documents, see js/agent.js) are blocked by the
// browser unless the bucket explicitly allows the calling origin. This is
// unrelated to storage.rules: rules control WHO can read a file, CORS
// controls whether a browser lets JS on a given origin read the response
// at all. getDownloadURL()-style links aren't affected, which is why this
// only shows up for the agent portal's document downloads, not logos.
//
// Usage (same env vars as scripts/migrateCompanies.js):
//   FIREBASE_PROJECT_ID=... FIREBASE_CLIENT_EMAIL=... FIREBASE_PRIVATE_KEY=... \
//     node scripts/setStorageCors.js https://your-domain.vercel.app [more-origins...]
//
// Re-run this whenever you add a custom domain or a new Vercel preview
// domain that needs to fetch documents from the agent portal.
const { GoogleAuth } = require('google-auth-library');

const origins = process.argv.slice(2);
if (!origins.length) {
  console.error('Usage: node scripts/setStorageCors.js <origin> [more-origins...]');
  process.exit(1);
}

async function main() {
  const auth = new GoogleAuth({
    credentials: {
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      private_key: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/devstorage.full_control'],
  });
  const client = await auth.getClient();
  const accessToken = (await client.getAccessToken()).token;

  const bucket = process.env.FIREBASE_STORAGE_BUCKET || `${process.env.FIREBASE_PROJECT_ID}.firebasestorage.app`;

  const res = await fetch(`https://storage.googleapis.com/storage/v1/b/${bucket}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cors: [
        {
          origin: origins,
          method: ['GET', 'HEAD'],
          responseHeader: ['Content-Type', 'Authorization', 'Content-Length', 'Content-Disposition'],
          maxAgeSeconds: 3600,
        },
      ],
    }),
  });

  const body = await res.json();
  if (!res.ok) {
    console.error('Failed:', JSON.stringify(body, null, 2));
    process.exit(1);
  }
  console.log('CORS updated for', bucket, ':', JSON.stringify(body.cors, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
