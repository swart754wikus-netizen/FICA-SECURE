import { auth, db, storage, signInWithCustomToken, apiGet, apiPost } from './firebaseClient.js';
import { collection, addDoc, doc, updateDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js';
import { ref, uploadBytes } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-storage.js';
import { FORM_TYPES, REQUIRED_DOCUMENTS_DEFAULT } from './formDefinitions.js';
import { renderForm, validateForm, collectAnswers } from './formRenderer.js';
import { initSignaturePad } from './signaturePad.js';

const state = {
  slug: new URLSearchParams(location.search).get('company') || '',
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

function renderDocumentList() {
  const docs = Array.isArray(state.requiredDocuments) ? state.requiredDocuments : REQUIRED_DOCUMENTS_DEFAULT;
  el('documentList').innerHTML = docs
    .map(
      (label, i) => `<div class="field">
        <label for="doc_${i}">${label}</label>
        <input type="file" id="doc_${i}" data-doc-label="${label}" accept="image/*,application/pdf">
      </div>`
    )
    .join('');
}

function sanitize(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function submitFica(signatureDataUrl) {
  const formDef = FORM_TYPES[state.formTypeKey];

  const submissionRef = await addDoc(collection(db, 'FICA_SUBMISSIONS'), {
    companyId: state.companyId,
    companyName: state.name,
    type: formDef.key,
    typeName: formDef.typeName,
    answers: state.answers,
    signature: signatureDataUrl,
    createdAt: serverTimestamp(),
  });

  const attachments = {};
  for (const [label, file] of Object.entries(state.files)) {
    const ext = (file.name.split('.').pop() || 'bin').toLowerCase();
    const path = `submissions/${state.companyId}/${submissionRef.id}/${sanitize(label)}.${ext}`;
    const storageRef = ref(storage, path);
    await uploadBytes(storageRef, file);
    // Deliberately not calling getDownloadURL(): its bearer-token link
    // bypasses storage.rules for anyone who ever obtains that URL string.
    // The agent portal fetches bytes on demand via the SDK instead, which
    // stays rule-enforced.
    attachments[label] = { path };
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

loadBranding();
wireEvents();
