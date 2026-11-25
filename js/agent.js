import { auth, db, storage, signInWithCustomToken, signOut, apiPost, setPersistence, browserSessionPersistence } from './firebaseClient.js';
import { collection, query, where, getDocs, doc, addDoc, updateDoc, serverTimestamp, Timestamp } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js';
import { ref, getBytes } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-storage.js';
import { FORM_TYPES, eddTriggers } from './formDefinitions.js';
import { renderForm, validateForm, collectAnswers } from './formRenderer.js';

// FICA s22–s23: records must be kept for at least 5 years. Deletion is blocked in
// firestore.rules / storage.rules until then; this constant only drives the UI notice.
const RETENTION_YEARS = 5;

const state = { companyId: null, name: '', slug: '', agent: null, submissions: [], invites: [], currentSubmissionId: null, mfaChallenge: null };
const IDLE_LOGOUT_MS = 20 * 60_000; // FICA records on screen: sign out unattended sessions
const el = (id) => document.getElementById(id);

const TYPE_COLORS = { natural: '#2563eb', company: '#b45309', trust: '#7c3aed', partnership: '#0d9488', enhanced: '#dc2626' };

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

/** Best-effort access log (who opened which client record/document). Enforced append-only by rules. */
function logAccess(action, submissionId, detail = null) {
  addDoc(collection(db, 'AUDIT_LOG'), {
    companyId: state.companyId,
    actor: auth.currentUser?.uid || 'unknown',
    action,
    submissionId: submissionId || null,
    detail,
    ts: serverTimestamp(),
  }).catch((err) => console.error('Audit log write failed', err));
}

function retainUntil(sub) {
  const d = sub.createdAt?.toDate ? sub.createdAt.toDate() : new Date();
  d.setFullYear(d.getFullYear() + RETENTION_YEARS);
  return d;
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
  const counts = { natural: 0, company: 0, trust: 0, partnership: 0 };
  let eddOutstanding = 0;
  state.submissions.forEach((s) => {
    if (counts[s.type] != null) counts[s.type]++;
    if (eddTriggers(s).length && !s.eddAssessment) eddOutstanding++;
  });
  const cards = [
    { label: 'Total submissions', value: state.submissions.length, color: '#0f2c4c' },
    { label: 'Natural Person', value: counts.natural, color: TYPE_COLORS.natural },
    { label: 'Company / CC', value: counts.company, color: TYPE_COLORS.company },
    { label: 'Trust', value: counts.trust, color: TYPE_COLORS.trust },
    { label: 'Partnership', value: counts.partnership, color: TYPE_COLORS.partnership },
    { label: 'EDD outstanding', value: eddOutstanding, color: TYPE_COLORS.enhanced },
  ];
  el('statGrid').innerHTML = cards
    .map((c) => `<div class="stat-card" style="--stat-color:${c.color}"><div class="value">${c.value}</div><div class="label">${c.label}</div></div>`)
    .join('');
}

function renderTable() {
  const search = el('searchInput').value.trim().toLowerCase();
  const typeFilter = el('typeFilter').value;

  const rows = state.submissions.filter((s) => {
    if (typeFilter === '__edd') { if (!eddTriggers(s).length || s.eddAssessment) return false; }
    else if (typeFilter && s.type !== typeFilter) return false;
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
        <td>${escapeHtml(summaryFor(s))}${eddTriggers(s).length ? ` <span class="risk-flag">${s.eddAssessment ? 'EDD done' : '⚠ EDD required'}</span>` : ''}</td>
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
  state.currentSubmissionId = id;

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
    .map(
      ([label, att]) =>
        `<li><button type="button" class="secondary" data-attachment-path="${escapeHtml(att.path)}" data-attachment-label="${escapeHtml(label)}" data-attachment-type="${escapeHtml(att.contentType || '')}">${escapeHtml(label)}</button></li>`
    )
    .join('');

  const reasons = eddTriggers(sub);
  const eddBanner = reasons.length
    ? `<div class="edd-banner ${sub.eddAssessment ? 'edd-done' : ''}">
        <strong>${sub.eddAssessment ? '✓ Enhanced due diligence completed' : '⚠ Enhanced due diligence required'}</strong>
        <ul>${reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
      </div>`
    : '';

  const eddSection = sub.eddAssessment
    ? `<h2>EDD risk assessment (internal)</h2>
       <p class="field-hint">Completed ${formatDate(sub.eddAssessment.completedAt)}${sub.eddAssessment.completedByName ? ` by ${escapeHtml(sub.eddAssessment.completedByName)}` : ''}. Locked — cannot be changed.</p>
       ${Object.entries(sub.eddAssessment.answers || {})
         .map(([q, a], i) => `<div class="qa" style="border-left-color:${TYPE_COLORS.enhanced}"><div class="q">${i + 1}. ${escapeHtml(q)}</div><div class="a">${escapeHtml(a) || '—'}</div></div>`)
         .join('')}`
    : `<div class="no-print">
         <h2>EDD risk assessment (internal)</h2>
         <p class="field-hint">${reasons.length ? 'Required for this client before you proceed.' : 'Optional for this client.'} Once saved it is locked as part of the FICA record.</p>
         <button type="button" class="${reasons.length ? '' : 'secondary'}" id="eddStart">Complete EDD risk assessment</button>
         <form id="eddForm" hidden novalidate></form>
         <div id="eddActions" hidden style="display:flex; gap:10px; margin-top:12px;">
           <button type="button" class="secondary" id="eddCancel">Cancel</button>
           <button type="button" id="eddSave">Save and lock assessment</button>
         </div>
         <div class="error" id="eddError" hidden></div>
       </div>`;

  el('detailContent').innerHTML = `
    <div class="doc-header">
      <span class="type-badge" style="background:${typeColor}">${escapeHtml(sub.typeName)}</span>
      <h2>${escapeHtml(sub.companyName)}</h2>
      <p class="field-hint">Submitted ${formatDate(sub.createdAt)} · Retained until ${retainUntil(sub).toLocaleDateString()} (FICA)</p>
    </div>
    ${eddBanner}
    ${qa}
    <h2>Documents</h2>
    <ul class="attachment-list">${attachments || '<li class="field-hint">No documents attached</li>'}</ul>
    <h2>Signature</h2>
    ${sub.signature ? `<img class="signature" src="${sub.signature}" alt="Client signature">` : '<p class="field-hint">No signature</p>'}
    ${eddSection}
  `;
  logAccess('submission.viewed', id);
  wireEddForm(sub);

  el('step-dashboard').hidden = true;
  el('step-detail').hidden = false;

  el('detailContent').querySelectorAll('[data-attachment-path]').forEach((btn) => {
    btn.addEventListener('click', () => viewAttachment(btn));
  });
}

let activePreviewUrl = null;

// Submissions made before contentType was recorded (see client.js) fall
// back to guessing from the file extension baked into the storage path.
function guessContentType(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return 'application/pdf';
  if (['jpg', 'jpeg'].includes(ext)) return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'heic') return 'image/heic';
  return 'application/octet-stream';
}

async function viewAttachment(btn) {
  const path = btn.dataset.attachmentPath;
  const label = btn.dataset.attachmentLabel;
  const contentType = btn.dataset.attachmentType || guessContentType(path);
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Opening…';

  // Fetched on demand via the SDK (rule-enforced) rather than linking a
  // stored getDownloadURL() — see client.js for why that URL is never
  // generated or stored in the first place.
  try {
    const bytes = await getBytes(ref(storage, path));
    const blob = new Blob([bytes], { type: contentType });
    if (activePreviewUrl) URL.revokeObjectURL(activePreviewUrl);
    activePreviewUrl = URL.createObjectURL(blob);

    el('docPreviewTitle').textContent = label;
    el('docPreviewDownload').href = activePreviewUrl;
    el('docPreviewDownload').download = path.split('/').pop() || label;

    if (contentType.startsWith('image/')) {
      el('docPreviewBody').innerHTML = `<img src="${activePreviewUrl}" alt="${escapeHtml(label)}">`;
    } else if (contentType === 'application/pdf') {
      el('docPreviewBody').innerHTML = `<iframe src="${activePreviewUrl}" title="${escapeHtml(label)}"></iframe>`;
    } else {
      el('docPreviewBody').innerHTML = `<p class="field-hint">Preview not supported for this file type — use Download instead.</p>`;
    }

    el('docPreviewOverlay').hidden = false;
    logAccess('document.viewed', state.currentSubmissionId, { label });
    btn.textContent = originalText;
    btn.disabled = false;
  } catch (err) {
    console.error('viewAttachment failed for', path, err);
    btn.textContent = `Failed — ${err.code || err.message || 'try again'}`;
    btn.disabled = false;
  }
}

function closeDocPreview() {
  el('docPreviewOverlay').hidden = true;
  el('docPreviewBody').innerHTML = '';
  if (activePreviewUrl) {
    URL.revokeObjectURL(activePreviewUrl);
    activePreviewUrl = null;
  }
}

function wireEddForm(sub) {
  const start = el('eddStart');
  if (!start) return;
  const form = el('eddForm');
  start.addEventListener('click', () => {
    renderForm(form, FORM_TYPES.enhanced);
    // Prefill identity fields the client already gave (same field names across forms).
    for (const f of FORM_TYPES[sub.type]?.fields || []) {
      const input = form.querySelector(`input[name="${f.name}"], textarea[name="${f.name}"]`);
      const value = sub.answers?.[f.label];
      if (input && value) input.value = value;
    }
    form.hidden = false;
    el('eddActions').hidden = false;
    start.hidden = true;
  });
  el('eddCancel').addEventListener('click', () => {
    form.hidden = true;
    form.innerHTML = '';
    el('eddActions').hidden = true;
    start.hidden = false;
  });
  el('eddSave').addEventListener('click', async () => {
    hideError('eddError');
    if (!validateForm(form)) return showError('eddError', 'Please complete all required fields.');
    if (!confirm('Save this EDD risk assessment? It will be locked as part of the FICA record and cannot be edited afterwards.')) return;
    el('eddSave').disabled = true;
    try {
      const eddAssessment = {
        answers: collectAnswers(form, FORM_TYPES.enhanced),
        completedAt: serverTimestamp(),
        completedBy: auth.currentUser.uid,
        ...(state.agent?.role !== 'legacy' ? { completedByName: state.agent.name } : {}),
      };
      await updateDoc(doc(db, 'FICA_SUBMISSIONS', sub.id), { eddAssessment });
      logAccess('edd.completed', sub.id);
      sub.eddAssessment = { ...eddAssessment, completedAt: Timestamp.now() };
      renderStats();
      renderTable();
      renderDetail(sub.id);
    } catch (err) {
      showError('eddError', err.message || 'Could not save the assessment.');
      el('eddSave').disabled = false;
    }
  });
}

const idToken = () => auth.currentUser.getIdToken();

// ---- Login: email + password, then authenticator code ------------------------------
function showAuthCard(id) {
  ['loginCard', 'legacyCard', 'mfaCard'].forEach((c) => (el(c).hidden = c !== id));
}

async function startSession(result) {
  // Session-only persistence: closing the tab/browser signs the agent out.
  await setPersistence(auth, browserSessionPersistence);
  await signInWithCustomToken(auth, result.token);
  state.companyId = result.companyId;
  state.name = result.name;
  state.slug = result.slug;
  state.agent = result.agent;

  el('topbar').hidden = false;
  el('topbarBrand').textContent = `Agent Portal · ${result.agent?.name || ''}`;
  renderAgencyHero(result.name, result.logoUrl);
  el('clientLink').value = `${location.origin}/?company=${result.slug}`;
  el('sharedLinkCard').hidden = !result.sharedLinkEnabled;
  el('teamCard').hidden = result.agent?.role !== 'principal';
  el('step-login').hidden = true;
  el('step-dashboard').hidden = false;
  startIdleTimer();

  await Promise.all([loadSubmissions(), loadInvites(), result.agent?.role === 'principal' ? loadTeam() : null]);
}

async function submitLogin() {
  hideError('loginError');
  const email = el('agentEmail').value.trim();
  const password = el('agentOwnPassword').value;
  if (!email || !password) return showError('loginError', 'Enter your email and password.');
  el('loginSubmit').disabled = true;
  try {
    const r = await apiPost('agentAuth', { action: 'login', email, password });
    state.mfaChallenge = r.challenge;
    el('enrollBox').hidden = r.step !== 'enroll';
    el('mfaHint').hidden = r.step === 'enroll';
    el('mfaTitle').textContent = r.step === 'enroll' ? 'Set up two-step verification' : 'Enter your 6-digit code';
    if (r.step === 'enroll') {
      el('enrollSecret').textContent = r.secret.replace(/(.{4})/g, '$1 ').trim();
      el('enrollLink').href = r.otpauthUri;
    }
    el('agentOwnPassword').value = '';
    showAuthCard('mfaCard');
    el('mfaCode').focus();
  } catch (err) {
    showError('loginError', err.message || 'Could not log in.');
  } finally {
    el('loginSubmit').disabled = false;
  }
}

async function submitMfa() {
  hideError('mfaError');
  const code = el('mfaCode').value.replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return showError('mfaError', 'Enter the 6-digit code from your app.');
  el('mfaSubmit').disabled = true;
  try {
    const r = await apiPost('agentAuth', { action: 'verify', challenge: state.mfaChallenge, code });
    state.mfaChallenge = null;
    await startSession(r);
  } catch (err) {
    showError('mfaError', err.message || 'Could not verify the code.');
    if (/start again|expired/i.test(err.message)) setTimeout(() => showAuthCard('loginCard'), 1500);
  } finally {
    el('mfaSubmit').disabled = false;
    el('mfaCode').value = '';
  }
}

async function submitLegacy() {
  hideError('legacyError');
  const name = el('companyName').value.trim();
  const password = el('agentPassword').value;
  if (!name || !password) return showError('legacyError', 'Enter your company name and password.');
  el('legacySubmit').disabled = true;
  try {
    await startSession(await apiPost('agentLogin', { name, password }));
  } catch (err) {
    showError('legacyError', err.message || 'Could not log in.');
  } finally {
    el('legacySubmit').disabled = false;
  }
}

let idleTimer = null;
function startIdleTimer() {
  const reset = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
      await signOut(auth);
      alert('You were signed out after 20 minutes of inactivity, to protect client information.');
      location.reload();
    }, IDLE_LOGOUT_MS);
  };
  ['click', 'keydown', 'mousemove', 'touchstart', 'scroll'].forEach((e) => document.addEventListener(e, reset, { passive: true }));
  reset();
}

// ---- Per-client invites -------------------------------------------------------------
function inviteStatus(inv) {
  if (state.submissions.some((s) => s.id === inv.id)) return 'submitted';
  if (inv.status === 'revoked') return 'revoked';
  const exp = inv.expiresAt?.toDate ? inv.expiresAt.toDate() : new Date(inv.expiresAt);
  return exp < new Date() ? 'expired' : 'pending';
}

async function loadInvites() {
  const snap = await getDocs(query(collection(db, 'INVITES'), where('companyId', '==', state.companyId)));
  state.invites = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0))
    .slice(0, 50);
  renderInvites();
}

function renderInvites() {
  el('inviteBody').innerHTML = state.invites.map((inv) => {
    const st = inviteStatus(inv);
    return `<tr>
      <td>${escapeHtml(inv.clientName)}<br><span class="field-hint">by ${escapeHtml(inv.createdByName || '')}</span></td>
      <td>${formatDate(inv.createdAt)}</td>
      <td><span class="status-pill ${st}">${st}</span></td>
      <td>${st === 'pending' ? `<button type="button" class="secondary" data-revoke="${inv.id}">Cancel link</button>` : ''}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="4" class="field-hint">No invites yet.</td></tr>';
  el('inviteBody').querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Cancel this link? The client will no longer be able to use it.')) return;
    b.disabled = true;
    try {
      await apiPost('clientInvite', { action: 'revoke', inviteId: b.dataset.revoke }, await idToken());
      await loadInvites();
    } catch (err) { b.textContent = 'Failed'; b.disabled = false; }
  }));
}

async function createInvite() {
  hideError('inviteError');
  const clientName = el('inviteName').value.trim();
  if (!clientName) return showError('inviteError', "Enter the client's name.");
  el('inviteCreate').disabled = true;
  try {
    const r = await apiPost('clientInvite', { action: 'create', clientName }, await idToken());
    const link = `${location.origin}/?company=${encodeURIComponent(state.slug)}&invite=${r.token}`;
    el('inviteLink').value = link;
    el('inviteResultName').textContent = clientName;
    const msg = `Hi ${clientName.split(' ')[0]}, please complete your FICA verification for ${state.name} using this secure, personal link (valid for 7 days): ${link}`;
    el('inviteWhatsApp').href = `https://wa.me/?text=${encodeURIComponent(msg)}`;
    el('inviteResult').hidden = false;
    el('inviteName').value = '';
    logAccess('invite.link_shown', r.inviteId);
    await loadInvites();
  } catch (err) {
    showError('inviteError', err.message || 'Could not create the link.');
  } finally {
    el('inviteCreate').disabled = false;
  }
}

// ---- Team management (principals) ---------------------------------------------------
async function teamCall(body) {
  return apiPost('manageAgents', { companyId: state.companyId, ...body }, await idToken());
}

async function loadTeam() {
  const { agents } = await teamCall({ action: 'list' });
  el('teamBody').innerHTML = agents.map((a) => `<tr>
      <td>${escapeHtml(a.name)}</td>
      <td>${escapeHtml(a.email)}</td>
      <td>${escapeHtml(a.role)}</td>
      <td><span class="status-pill ${a.active ? 'active' : 'inactive'}">${a.active ? (a.mfaEnrolled ? 'active' : 'awaiting first login') : 'deactivated'}</span></td>
      <td style="display:flex; gap:6px; flex-wrap:wrap;">
        <button type="button" class="secondary" data-act="${a.active ? 'deactivate' : 'activate'}" data-id="${a.id}">${a.active ? 'Deactivate' : 'Reactivate'}</button>
        <button type="button" class="secondary" data-act="resetMfa" data-id="${a.id}">Reset 2-step</button>
        <button type="button" class="secondary" data-act="resetPassword" data-id="${a.id}">New password</button>
      </td>
    </tr>`).join('');
  el('teamBody').querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => teamAction(b)));
}

async function teamAction(b) {
  hideError('teamError');
  const { act, id } = b.dataset;
  try {
    if (act === 'deactivate' || act === 'activate') {
      if (act === 'deactivate' && !confirm('Deactivate this person? They are signed out and can no longer log in.')) return;
      await teamCall({ action: 'setActive', agentId: id, active: act === 'activate' });
    } else if (act === 'resetMfa') {
      if (!confirm('Reset two-step verification? They will set up their authenticator again at next login (use this if they lost their phone).')) return;
      await teamCall({ action: 'resetMfa', agentId: id });
    } else if (act === 'resetPassword') {
      const password = prompt('New temporary password (at least 10 characters). Give it to them in person or by phone:');
      if (!password) return;
      await teamCall({ action: 'resetPassword', agentId: id, password });
    }
    await loadTeam();
  } catch (err) {
    showError('teamError', err.message || 'Could not update the team.');
  }
}

async function addTeamMember() {
  hideError('teamError');
  el('teamAdd').disabled = true;
  try {
    await teamCall({
      action: 'create',
      name: el('teamName').value.trim(),
      email: el('teamEmail').value.trim(),
      role: el('teamRole').value,
      password: el('teamPassword').value,
    });
    ['teamName', 'teamEmail', 'teamPassword'].forEach((i) => (el(i).value = ''));
    await loadTeam();
  } catch (err) {
    showError('teamError', err.message || 'Could not add this person.');
  } finally {
    el('teamAdd').disabled = false;
  }
}

function wireEvents() {
  el('loginSubmit').addEventListener('click', submitLogin);
  el('agentOwnPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitLogin(); });
  el('mfaSubmit').addEventListener('click', submitMfa);
  el('mfaCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitMfa(); });
  el('legacySubmit').addEventListener('click', submitLegacy);
  el('showLegacy').addEventListener('click', () => showAuthCard('legacyCard'));
  el('showLogin').addEventListener('click', () => showAuthCard('loginCard'));
  el('inviteCreate').addEventListener('click', createInvite);
  el('inviteCopy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(el('inviteLink').value);
    el('inviteCopy').textContent = 'Copied!';
    setTimeout(() => (el('inviteCopy').textContent = 'Copy'), 1500);
  });
  el('teamAdd').addEventListener('click', addTeamMember);

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
  el('docPreviewClose').addEventListener('click', closeDocPreview);
  el('docPreviewOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'docPreviewOverlay') closeDocPreview();
  });
}

wireEvents();
