import { auth, db, storage, signInWithEmailAndPassword, signOut, apiPost } from './firebaseClient.js';
import { collection, getDocs, doc, updateDoc, deleteDoc } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js';
import { ref, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-storage.js';

const state = { companies: [], editingId: null };
const el = (id) => document.getElementById(id);

function showError(id, message) {
  const box = el(id);
  box.textContent = message;
  box.hidden = false;
}
function hideError(id) {
  el(id).hidden = true;
}

async function authedFetch(path, body) {
  const idToken = await auth.currentUser.getIdToken();
  return apiPost(path, body, idToken);
}

async function loadCompanies() {
  const snap = await getDocs(collection(db, 'COMPANIES'));
  state.companies = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  renderStats();
  renderTable();
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// One calendar month out from a YYYY-MM-DD string, kept as a plain date
// string (not a Firestore Timestamp) since these are only ever compared/
// displayed as dates, never queried by time-of-day.
function addMonthISO(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + 1);
  const daysInTargetMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, daysInTargetMonth));
  return d.toISOString().slice(0, 10);
}

function dueInfo(nextDueAt) {
  if (!nextDueAt) return { label: '—', className: '' };
  const today = todayISO();
  if (nextDueAt < today) return { label: nextDueAt, className: 'badge--suspended' };
  const soon = new Date(today + 'T00:00:00');
  soon.setDate(soon.getDate() + 7);
  if (nextDueAt <= soon.toISOString().slice(0, 10)) return { label: nextDueAt, className: 'badge--trial' };
  return { label: nextDueAt, className: 'badge--active' };
}

function renderStats() {
  const active = state.companies.filter((c) => c.status === 'active').length;
  const paid = state.companies.filter((c) => c.payment === 'paid').length;
  const today = todayISO();
  const overdue = state.companies.filter((c) => c.nextDueAt && c.nextDueAt < today).length;
  const cards = [
    { label: 'Companies', value: state.companies.length },
    { label: 'Active', value: active },
    { label: 'Paid', value: paid },
    { label: 'Overdue', value: overdue },
  ];
  el('statGrid').innerHTML = cards.map((c) => `<div class="stat-card"><div class="value">${c.value}</div><div class="label">${c.label}</div></div>`).join('');
}

function renderTable() {
  const search = el('searchInput').value.trim().toLowerCase();
  const rows = state.companies.filter((c) => !search || `${c.name} ${c.slug}`.toLowerCase().includes(search));

  el('companiesBody').innerHTML = rows
    .map((c) => {
      const due = dueInfo(c.nextDueAt);
      return `<tr data-id="${c.id}">
        <td>${c.name}</td>
        <td>${c.slug}</td>
        <td><span class="badge badge--${c.status}">${c.status}</span></td>
        <td><span class="badge badge--${c.payment}">${c.payment}</span></td>
        <td>${due.className ? `<span class="badge ${due.className}">${due.label}</span>` : due.label}</td>
        <td><button type="button" class="secondary" data-edit="${c.id}">Edit</button></td>
      </tr>`;
    })
    .join('');

  el('companiesBody').querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => openEdit(btn.dataset.edit));
  });
}

function openEdit(id) {
  const company = state.companies.find((c) => c.id === id);
  if (!company) return;
  state.editingId = id;
  hideError('editError');

  el('editTitle').textContent = `Edit ${company.name}`;
  el('editName').value = company.name || '';
  el('editTagline').value = company.tagline || '';
  el('editStatus').value = company.status || 'trial';
  el('editPayment').value = company.payment || 'unpaid';
  el('editLastPaidAt').value = company.lastPaidAt || '';
  el('editNextDueAt').value = company.nextDueAt || '';
  el('editAccessCode').value = '';
  el('editAgentPassword').value = '';
  el('editLogo').value = '';
  if (company.logoUrl) {
    el('editLogoPreview').src = company.logoUrl;
    el('editLogoPreview').hidden = false;
  } else {
    el('editLogoPreview').hidden = true;
  }

  el('step-dashboard').hidden = true;
  el('step-edit').hidden = false;
}

async function saveEdit() {
  hideError('editError');
  const id = state.editingId;
  el('editSave').disabled = true;
  try {
    let logoUrl;
    const file = el('editLogo').files[0];
    if (file) {
      const storageRef = ref(storage, `logos/${id}-${Date.now()}-${file.name}`);
      await uploadBytes(storageRef, file);
      logoUrl = await getDownloadURL(storageRef);
    }

    await authedFetch('adminUpdateCompany', {
      companyId: id,
      name: el('editName').value.trim(),
      tagline: el('editTagline').value.trim(),
      status: el('editStatus').value,
      payment: el('editPayment').value,
      lastPaidAt: el('editLastPaidAt').value || null,
      nextDueAt: el('editNextDueAt').value || null,
      ...(logoUrl ? { logoUrl } : {}),
      ...(el('editAccessCode').value ? { accessCode: el('editAccessCode').value } : {}),
      ...(el('editAgentPassword').value ? { agentPassword: el('editAgentPassword').value } : {}),
    });

    await loadCompanies();
    el('step-edit').hidden = true;
    el('step-dashboard').hidden = false;
  } catch (err) {
    showError('editError', err.message || 'Could not save changes.');
  } finally {
    el('editSave').disabled = false;
  }
}

async function deleteCompany() {
  const id = state.editingId;
  const company = state.companies.find((c) => c.id === id);
  if (!confirm(`Delete ${company?.name}? This cannot be undone.`)) return;
  try {
    await deleteDoc(doc(db, 'COMPANIES', id));
    await loadCompanies();
    el('step-edit').hidden = true;
    el('step-dashboard').hidden = false;
  } catch (err) {
    showError('editError', err.message || 'Could not delete company.');
  }
}

function wireEvents() {
  el('loginSubmit').addEventListener('click', async () => {
    hideError('loginError');
    el('loginSubmit').disabled = true;
    try {
      await signInWithEmailAndPassword(auth, el('email').value.trim(), el('password').value);
      el('topbar').hidden = false;
      el('step-login').hidden = true;
      el('step-dashboard').hidden = false;
      await loadCompanies();
    } catch (err) {
      showError('loginError', 'Could not log in with those credentials.');
    } finally {
      el('loginSubmit').disabled = false;
    }
  });

  el('logoutBtn').addEventListener('click', async () => {
    await signOut(auth);
    location.reload();
  });

  el('createSubmit').addEventListener('click', async () => {
    hideError('createError');
    const name = el('newName').value.trim();
    const slug = el('newSlug').value.trim();
    const accessCode = el('newAccessCode').value;
    const agentPassword = el('newAgentPassword').value;
    if (!name || !slug || !accessCode || !agentPassword) {
      return showError('createError', 'Name, slug, access code, and agent password are all required.');
    }
    el('createSubmit').disabled = true;
    try {
      await authedFetch('adminCreateCompany', {
        name,
        slug,
        accessCode,
        agentPassword,
        status: el('newStatus').value,
        payment: el('newPayment').value,
      });
      el('newName').value = '';
      el('newSlug').value = '';
      el('newAccessCode').value = '';
      el('newAgentPassword').value = '';
      await loadCompanies();
    } catch (err) {
      showError('createError', err.message || 'Could not create company.');
    } finally {
      el('createSubmit').disabled = false;
    }
  });

  el('searchInput').addEventListener('input', renderTable);
  el('editBack').addEventListener('click', () => {
    el('step-edit').hidden = true;
    el('step-dashboard').hidden = false;
  });
  el('editSave').addEventListener('click', saveEdit);
  el('editDelete').addEventListener('click', deleteCompany);
  el('markPaidToday').addEventListener('click', () => {
    const today = todayISO();
    el('editLastPaidAt').value = today;
    el('editNextDueAt').value = addMonthISO(today);
    el('editPayment').value = 'paid';
  });
}

wireEvents();
