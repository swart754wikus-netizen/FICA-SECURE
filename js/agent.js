import { auth, db, storage, signInWithCustomToken, signOut, apiPost } from './firebaseClient.js';
import { collection, query, where, getDocs } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js';
import { ref, getBytes } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-storage.js';

const state = { companyId: null, name: '', slug: '', submissions: [] };
const el = (id) => document.getElementById(id);

function showError(id, message) {
  const box = el(id);
  box.textContent = message;
  box.hidden = false;
}
function hideError(id) {
  el(id).hidden = true;
}

function summaryFor(sub) {
  const values = Object.values(sub.answers || {});
  return values[0] || '(no summary)';
}

function formatDate(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function loadSubmissions() {
  // Sorted client-side rather than via Firestore orderBy() — combining
  // where() on one field with orderBy() on another needs a composite index,
  // which doesn't exist for this project and isn't worth provisioning for a
  // per-agency result set of this size.
  const q = query(collection(db, 'FICA_SUBMISSIONS'), where('companyId', '==', state.companyId));
  const snap = await getDocs(q);
  state.submissions = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));
  renderStats();
  renderTable();
}

function renderStats() {
  const counts = { natural: 0, trust: 0, partnership: 0, enhanced: 0 };
  state.submissions.forEach((s) => { if (counts[s.type] != null) counts[s.type]++; });
  const cards = [
    { label: 'Total submissions', value: state.submissions.length },
    { label: 'Natural Person', value: counts.natural },
    { label: 'Trust', value: counts.trust },
    { label: 'Partnership', value: counts.partnership },
    { label: 'Enhanced DD', value: counts.enhanced },
  ];
  el('statGrid').innerHTML = cards.map((c) => `<div class="stat-card"><div class="value">${c.value}</div><div class="label">${c.label}</div></div>`).join('');
}

function renderTable() {
  const search = el('searchInput').value.trim().toLowerCase();
  const typeFilter = el('typeFilter').value;

  const rows = state.submissions.filter((s) => {
    if (typeFilter && s.type !== typeFilter) return false;
    if (!search) return true;
    const haystack = `${s.typeName} ${JSON.stringify(s.answers || {})}`.toLowerCase();
    return haystack.includes(search);
  });

  el('emptyState').hidden = rows.length > 0;
  el('submissionsBody').innerHTML = rows
    .map(
      (s) => `<tr data-id="${s.id}">
        <td>${formatDate(s.createdAt)}</td>
        <td>${s.typeName}</td>
        <td>${summaryFor(s)}</td>
      </tr>`
    )
    .join('');

  el('submissionsBody').querySelectorAll('tr').forEach((row) => {
    row.addEventListener('click', () => renderDetail(row.dataset.id));
  });
}

function renderDetail(id) {
  const sub = state.submissions.find((s) => s.id === id);
  if (!sub) return;

  const qa = Object.entries(sub.answers || {})
    .map(([q, a]) => `<div class="qa"><div class="q">${q}</div><div class="a">${a || '—'}</div></div>`)
    .join('');

  const attachments = Object.entries(sub.attachments || {})
    .map(([label, att]) => `<li><button type="button" class="secondary" data-attachment-path="${att.path}" data-attachment-label="${label}">${label}</button></li>`)
    .join('');

  el('detailContent').innerHTML = `
    <h2>${sub.typeName} — ${sub.companyName}</h2>
    <p class="field-hint">Submitted ${formatDate(sub.createdAt)}</p>
    ${qa}
    <h2>Documents</h2>
    <ul class="attachment-list">${attachments || '<li class="field-hint">No documents attached</li>'}</ul>
    <h2>Signature</h2>
    ${sub.signature ? `<img class="signature" src="${sub.signature}" alt="Client signature">` : '<p class="field-hint">No signature</p>'}
  `;

  el('step-dashboard').hidden = true;
  el('step-detail').hidden = false;

  el('detailContent').querySelectorAll('[data-attachment-path]').forEach((btn) => {
    btn.addEventListener('click', () => downloadAttachment(btn.dataset.attachmentPath, btn.dataset.attachmentLabel));
  });
}

async function downloadAttachment(path, label) {
  // Fetched on demand via the SDK (rule-enforced) rather than linking a
  // stored getDownloadURL() — see client.js for why that URL is never
  // generated or stored in the first place.
  try {
    const bytes = await getBytes(ref(storage, path));
    const blob = new Blob([bytes]);
    const blobUrl = URL.createObjectURL(blob);
    const filename = path.split('/').pop() || label;
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
  } catch (err) {
    alert(`Could not load ${label}: ${err.message || err}`);
  }
}

function wireEvents() {
  el('loginSubmit').addEventListener('click', async () => {
    hideError('loginError');
    const name = el('companyName').value.trim();
    const password = el('agentPassword').value;
    if (!name || !password) return showError('loginError', 'Enter your company name and password.');
    el('loginSubmit').disabled = true;
    try {
      const result = await apiPost('agentLogin', { name, password });
      await signInWithCustomToken(auth, result.token);
      state.companyId = result.companyId;
      state.name = result.name;
      state.slug = result.slug;

      el('topbar').hidden = false;
      el('topbarBrand').textContent = result.name;
      el('clientLink').value = `${location.origin}/?company=${result.slug}`;
      el('step-login').hidden = true;
      el('step-dashboard').hidden = false;

      await loadSubmissions();
    } catch (err) {
      showError('loginError', err.message || 'Could not log in.');
    } finally {
      el('loginSubmit').disabled = false;
    }
  });

  el('logoutBtn').addEventListener('click', async () => {
    await signOut(auth);
    location.reload();
  });

  el('copyLinkBtn').addEventListener('click', async () => {
    await navigator.clipboard.writeText(el('clientLink').value);
    el('copyLinkBtn').textContent = 'Copied!';
    setTimeout(() => (el('copyLinkBtn').textContent = 'Copy'), 1500);
  });

  el('searchInput').addEventListener('input', renderTable);
  el('typeFilter').addEventListener('change', renderTable);

  el('detailBack').addEventListener('click', () => {
    el('step-detail').hidden = true;
    el('step-dashboard').hidden = false;
  });
  el('printBtn').addEventListener('click', () => window.print());
}

wireEvents();
