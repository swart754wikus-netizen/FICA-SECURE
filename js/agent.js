import { auth, db, storage, signInWithCustomToken, signOut, apiPost } from './firebaseClient.js';
import { collection, query, where, getDocs } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js';
import { ref, getBytes } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-storage.js';
import { FORM_TYPES } from './formDefinitions.js';

const state = { companyId: null, name: '', slug: '', submissions: [] };
const el = (id) => document.getElementById(id);

const TYPE_COLORS = { natural: '#2563eb', trust: '#7c3aed', partnership: '#0d9488', enhanced: '#dc2626' };

// Yes/No questions where "Yes" is a compliance flag worth an agent's
// attention at a glance, not just plain text to read past.
const RISK_FLAG_LABELS = new Set([
  'Have you ever held a prominent public function in a foreign country?',
  'Have you held a domestic prominent influential position in the last 12 months?',
  'Are you a family member or close associate of a PEP/DPIP/DPEP?',
  'Enhanced due diligence required?',
  'Discuss with FCO?',
]);

// Firestore does not guarantee map-field key order on read-back, so
// Object.entries(sub.answers) can come back in a different order than the
// form was filled in — wrong for a compliance document, which should read
// in the same order as the form itself. Rebuild that order from the form
// definition instead of trusting whatever order Firestore returns.
function orderedAnswerEntries(sub) {
  const answers = sub.answers || {};
  const formDef = FORM_TYPES[sub.type];
  if (!formDef) return Object.entries(answers);

  const seen = new Set();
  const ordered = [];

  function addField(field) {
    if (field.label in answers) {
      ordered.push([field.label, answers[field.label]]);
      seen.add(field.label);
    }
    if (field.special) field.special.reveal.forEach(addField);
  }
  formDef.fields.forEach(addField);

  // Any leftover keys not in the current form definition (e.g. the form
  // shape changed after this submission was made) still get shown, just
  // appended at the end rather than silently dropped.
  Object.entries(answers).forEach(([label, value]) => {
    if (!seen.has(label)) ordered.push([label, value]);
  });

  return ordered;
}

function showError(id, message) {
  const box = el(id);
  box.textContent = message;
  box.hidden = false;
}
function hideError(id) {
  el(id).hidden = true;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderAgencyHero(name, logoUrl) {
  if (logoUrl) {
    // The logo image already carries the agency's name/wordmark — repeating
    // it as a heading underneath just reads as duplicated, not premium.
    el('agencyHero').innerHTML = `<img src="${logoUrl}" alt="${escapeHtml(name)} logo">`;
    return;
  }
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  el('agencyHero').innerHTML = `<div class="agency-hero-fallback">${initial}</div><div class="agency-hero-name">${escapeHtml(name)}</div>`;
}

function summaryFor(sub) {
  const formDef = FORM_TYPES[sub.type];
  const firstLabel = formDef?.fields?.[0]?.label;
  const value = firstLabel && sub.answers ? sub.answers[firstLabel] : undefined;
  return value || Object.values(sub.answers || {})[0] || '(no summary)';
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
    { label: 'Total submissions', value: state.submissions.length, color: '#0f2c4c' },
    { label: 'Natural Person', value: counts.natural, color: TYPE_COLORS.natural },
    { label: 'Trust', value: counts.trust, color: TYPE_COLORS.trust },
    { label: 'Partnership', value: counts.partnership, color: TYPE_COLORS.partnership },
    { label: 'Enhanced DD', value: counts.enhanced, color: TYPE_COLORS.enhanced },
  ];
  el('statGrid').innerHTML = cards
    .map((c) => `<div class="stat-card" style="--stat-color:${c.color}"><div class="value">${c.value}</div><div class="label">${c.label}</div></div>`)
    .join('');
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
        <td><span class="type-badge" style="background:${TYPE_COLORS[s.type] || '#64748b'}">${escapeHtml(s.typeName)}</span></td>
        <td>${escapeHtml(summaryFor(s))}</td>
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

  const typeColor = TYPE_COLORS[sub.type] || '#64748b';

  const qa = orderedAnswerEntries(sub)
    .map(([q, a], index) => {
      const isFlagged = RISK_FLAG_LABELS.has(q) && String(a).trim().toLowerCase() === 'yes';
      const valueHtml = isFlagged
        ? `<span class="risk-flag">⚠ ${escapeHtml(a)}</span>`
        : escapeHtml(a) || '—';
      return `<div class="qa" style="border-left-color:${typeColor}"><div class="q">${index + 1}. ${escapeHtml(q)}</div><div class="a">${valueHtml}</div></div>`;
    })
    .join('');

  const attachments = Object.entries(sub.attachments || {})
    .map(([label, att]) => `<li><button type="button" class="secondary" data-attachment-path="${escapeHtml(att.path)}" data-attachment-label="${escapeHtml(label)}">${escapeHtml(label)}</button></li>`)
    .join('');

  el('detailContent').innerHTML = `
    <div class="doc-header">
      <span class="type-badge" style="background:${typeColor}">${escapeHtml(sub.typeName)}</span>
      <h2>${escapeHtml(sub.companyName)}</h2>
      <p class="field-hint">Submitted ${formatDate(sub.createdAt)}</p>
    </div>
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
      el('topbarBrand').textContent = 'Agent Portal';
      renderAgencyHero(result.name, result.logoUrl);
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
