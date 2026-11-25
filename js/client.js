import { auth, db, storage, signInWithCustomToken, apiGet, apiPost } from './firebaseClient.js';
import { collection, addDoc, setDoc, doc, updateDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js';
import { ref, uploadBytes } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-storage.js';
import { CLIENT_FORM_TYPES as FORM_TYPES, REQUIRED_DOCUMENTS_BY_TYPE } from './formDefinitions.js';
import { renderForm, validateForm, collectAnswers } from './formRenderer.js';
import { initSignaturePad } from './signaturePad.js';

const state = {
  slug: new URLSearchParams(location.search).get('company') || '',
  invite: new URLSearchParams(location.search).get('invite') || '',
  inviteId: null,
  companyId: null,
  name: '',
  requiredDocuments: null,
  formTypeKey: null,
  answers: null,
  files: {},
};

const el = (id) => document.getElementById(id);
const STEPS = ['step-auth', 'step-type', 'step-form', 'step-documents', 'step-signature', 'step-success'];
const PROGRESS = { 'step-type': 10, 'step-form': 35, 'step-documents': 65, 'step-signature': 85, 'step-success': 100 };

function showStep(id) {
  STEPS.forEach((s) => (el(s).hidden = s !== id));
  if (PROGRESS[id] != null) el('formProgress').style.width = `${PROGRESS[id]}%`;
}

function showError(id, message) {
  const box = el(id);
  box.textContent = message;
  box.hidden = false;
}
function hideError(id) {
  el(id).hidden = true;
}

async function loadBranding() {
  if (!state.slug) {
    showError('authError', 'This link is missing a company reference. Ask your agent for the correct link.');
    el('authSubmit').disabled = true;
    return;
  }
  try {
    const branding = await apiGet('getCompanyBranding', { slug: state.slug });
    el('brandHeader').hidden = false;
    el('brandTagline').textContent = branding.tagline || '';
    if (branding.logoUrl) {
      // The logo already carries the agency's name — showing the name again
      // as a heading right under it is just duplication, not branding.
      el('brandLogo').src = branding.logoUrl;
      el('brandLogo').hidden = false;
      el('brandName').hidden = true;
    } else {
      el('brandName').textContent = branding.name;
      el('brandName').hidden = false;
    }
    if (branding.status === 'suspended') {
      showError('authError', 'This agency portal is currently unavailable.');
      el('authSubmit').disabled = true;
    }
  } catch (err) {
    showError('authError', 'This link is invalid. Ask your agent for the correct link.');
    el('authSubmit').disabled = true;
  }
  return null;
}

function renderTypeGrid() {
  el('typeGrid').innerHTML = Object.values(FORM_TYPES)
    .map((t) => `<button type="button" class="type-card" data-type="${t.key}"><strong>${t.typeName}</strong></button>`)
    .join('');
  el('typeGrid').querySelectorAll('[data-type]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.formTypeKey = btn.dataset.type;
      const formDef = FORM_TYPES[state.formTypeKey];
      el('formTitle').textContent = formDef.typeName;
      renderForm(el('ficaForm'), formDef);
      showStep('step-form');
    });
  });
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderDocumentList() {
  // Agency-configured list wins; otherwise use the defaults for this client type.
  const docs = Array.isArray(state.requiredDocuments) && state.requiredDocuments.length
    ? state.requiredDocuments
    : REQUIRED_DOCUMENTS_BY_TYPE[state.formTypeKey] || REQUIRED_DOCUMENTS_BY_TYPE.natural;
  el('documentList').innerHTML = docs
    .map(
      (label, i) => `<div class="field">
        <label for="doc_${i}">${escapeHtml(label)}</label>
        <input type="file" id="doc_${i}" data-doc-label="${escapeHtml(label)}" accept="image/jpeg,image/png,image/heic,image/heif,image/webp,application/pdf">
      </div>`
    )
    .join('');
}

/** Personal invite link: no access code needed, and the link works for one submission only. */
async function redeemInvite() {
  el('authSubmit').disabled = true;
  el('accessCode').closest('.field').hidden = true;
  el('step-auth').querySelector('h2').textContent = 'Opening your secure form…';
  el('step-auth').querySelector('.field-hint').textContent = '';
  try {
    const result = await apiPost('clientInvite', { action: 'redeem', slug: state.slug, invite: state.invite });
    await signInWithCustomToken(auth, result.token);
    // Don't leave the single-use token sitting in the address bar / browser history.
    history.replaceState(null, '', `${location.pathname}?company=${encodeURIComponent(state.slug)}`);
    state.companyId = result.companyId;
    state.name = result.name;
    state.inviteId = result.inviteId;
    state.requiredDocuments = result.requiredDocuments;
    el('typeGreeting').textContent = `Hi ${result.clientName.split(' ')[0]}, please select the option that describes you.`;
    renderTypeGrid();
    showStep('step-type');
  } catch (err) {
    el('step-auth').querySelector('h2').textContent = 'Link unavailable';
    showError('authError', err.message || 'This link is invalid. Ask your agent for a new one.');
  }
}

function sanitize(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function submitFica(signatureDataUrl) {
  const formDef = FORM_TYPES[state.formTypeKey];

  const data = {
    companyId: state.companyId,
    companyName: state.name,
    type: formDef.key,
    typeName: formDef.typeName,
    answers: state.answers,
    signature: signatureDataUrl,
    createdAt: serverTimestamp(),
  };
  let submissionRef;
  if (state.inviteId) {
    // Submission ID = invite ID: firestore.rules allow exactly one per personal link.
    submissionRef = doc(db, 'FICA_SUBMISSIONS', state.inviteId);
    await setDoc(submissionRef, { ...data, inviteId: state.inviteId });
  } else {
    submissionRef = await addDoc(collection(db, 'FICA_SUBMISSIONS'), data);
  }

  const attachments = {};
  for (const [label, file] of Object.entries(state.files)) {
    const ext = (file.name.split('.').pop() || 'bin').toLowerCase();
    const path = `submissions/${state.companyId}/${submissionRef.id}/${sanitize(label)}.${ext}`;
    const storageRef = ref(storage, path);
    await uploadBytes(storageRef, file);
    // Deliberately not calling getDownloadURL(): its bearer-token link
    // bypasses storage.rules for anyone who ever obtains that URL string.
    // The agent portal fetches bytes on demand via the SDK instead, which
    // stays rule-enforced. contentType is stored so the agent portal can
    // preview the file inline instead of guessing a MIME type from the
    // file extension.
    attachments[label] = { path, contentType: file.type || 'application/octet-stream' };
  }

  if (Object.keys(attachments).length) {
    await updateDoc(doc(db, 'FICA_SUBMISSIONS', submissionRef.id), { attachments });
  }
}

function wireEvents() {
  el('authSubmit').addEventListener('click', async () => {
    hideError('authError');
    const accessCode = el('accessCode').value.trim();
    if (!accessCode) return showError('authError', 'Enter your access code.');
    el('authSubmit').disabled = true;
    try {
      const result = await apiPost('checkClientAccessCode', { slug: state.slug, accessCode });
      await signInWithCustomToken(auth, result.token);
      state.companyId = result.companyId;
      state.name = result.name;
      state.requiredDocuments = result.requiredDocuments;
      renderTypeGrid();
      showStep('step-type');
    } catch (err) {
      showError('authError', err.message || 'Could not verify access code.');
    } finally {
      el('authSubmit').disabled = false;
    }
  });

  el('formNext').addEventListener('click', () => {
    hideError('formError');
    if (!validateForm(el('ficaForm'))) return showError('formError', 'Please complete all required fields.');
    state.answers = collectAnswers(el('ficaForm'), FORM_TYPES[state.formTypeKey]);
    renderDocumentList();
    showStep('step-documents');
  });
  el('formBack').addEventListener('click', () => showStep('step-type'));

  el('documentsNext').addEventListener('click', () => {
    hideError('documentsError');
    const inputs = Array.from(document.querySelectorAll('#documentList input[type="file"]'));
    const missing = inputs.filter((i) => !i.files.length);
    if (missing.length) return showError('documentsError', 'Please upload all required documents.');
    state.files = {};
    inputs.forEach((i) => (state.files[i.dataset.docLabel] = i.files[0]));
    showStep('step-signature');
  });
  el('documentsBack').addEventListener('click', () => showStep('step-form'));

  const pad = initSignaturePad(el('signatureCanvas'));
  el('signatureClear').addEventListener('click', () => pad.clear());
  el('signatureBack').addEventListener('click', () => showStep('step-documents'));
  el('signatureSubmit').addEventListener('click', async () => {
    hideError('signatureError');
    if (pad.isEmpty()) return showError('signatureError', 'Please sign before submitting.');
    el('signatureSubmit').disabled = true;
    try {
      await submitFica(pad.toDataURL());
      showStep('step-success');
    } catch (err) {
      showError('signatureError', err.message || 'Submission failed. Please try again.');
    } finally {
      el('signatureSubmit').disabled = false;
    }
  });
}

loadBranding().then(() => { if (state.invite && !el('authSubmit').disabled) redeemInvite(); });
wireEvents();
