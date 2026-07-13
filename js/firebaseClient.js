import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js';
import { getAuth, signInWithCustomToken, signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js';
import { getStorage } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-storage.js';

// Values below are the PUBLIC web app config from Firebase Console →
// Project settings → Your apps. This is safe to expose in client code (it is
// not a secret) — see README for where to get it for your own project.
const firebaseConfig = {
  apiKey: 'AIzaSyD9pMr5ROToovR9kCzdjrPixCDWIuJYE9o',
  authDomain: 'fica-app-fc93c.firebaseapp.com',
  projectId: 'fica-app-fc93c',
  storageBucket: 'fica-app-fc93c.firebasestorage.app',
  messagingSenderId: '333389813135',
  appId: '1:333389813135:web:151878ebed613e858a27fa',
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

export { signInWithCustomToken, signInWithEmailAndPassword, signOut, onAuthStateChanged };

export async function apiPost(path, body, idToken) {
  const headers = { 'Content-Type': 'application/json' };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  const res = await fetch(`/api/${path}`, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export async function apiGet(path, params) {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const res = await fetch(`/api/${path}${qs}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
