// Minimal in-memory stand-in for the firebase-admin surface the /api functions use.
const { Timestamp } = require('firebase-admin/firestore');

const store = new Map();
let autoId = 0;
const toStored = (v) => {
  if (v instanceof Date) return Timestamp.fromDate(v);
  if (v && typeof v === 'object' && !(v instanceof Timestamp) && !Array.isArray(v)) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toStored(x)]));
  }
  return v;
};

function docRef(col, id) {
  const path = `${col}/${id}`;
  return {
    id,
    async get() { const d = store.get(path); return { id, exists: d !== undefined, data: () => (d ? { ...d } : undefined) }; },
    async create(data) { if (store.has(path)) throw Object.assign(new Error('exists'), { code: 6 }); store.set(path, toStored(data)); },
    async set(data) { store.set(path, toStored(data)); },
    async update(data) { if (!store.has(path)) throw new Error('not found'); store.set(path, { ...store.get(path), ...toStored(data) }); },
  };
}

function query(col, filters = [], lim = Infinity) {
  return {
    where: (f, op, v) => query(col, [...filters, [f, v]], lim),
    limit: (n) => query(col, filters, n),
    async get() {
      const docs = [...store.entries()]
        .filter(([p, d]) => p.startsWith(`${col}/`) && filters.every(([f, v]) => d[f] === v))
        .slice(0, lim)
        .map(([p, d]) => ({ id: p.slice(col.length + 1), exists: true, data: () => ({ ...d }) }));
      return { empty: docs.length === 0, docs };
    },
  };
}

const db = {
  collection: (col) => ({
    doc: (id) => docRef(col, id),
    where: (f, op, v) => query(col).where(f, op, v),
    async add(data) { const id = `auto${++autoId}`; store.set(`${col}/${id}`, toStored(data)); return { id }; },
  }),
  async runTransaction(fn) {
    return fn({ get: (r) => r.get(), set: (r, d) => r.set(d), update: (r, d) => r.update(d) });
  },
};

const tokens = new Map(); // fake ID tokens: "tok:<n>" -> decoded claims
const revoked = [];
const auth = {
  async createCustomToken(uid, claims) { return JSON.stringify({ uid, claims }); },
  async verifyIdToken(t) { if (!tokens.has(t)) throw new Error('bad token'); return tokens.get(t); },
  async revokeRefreshTokens(uid) { revoked.push(uid); },
};

module.exports = { db, auth, store, tokens, revoked, admin: {} };
