function fieldMarkup(field) {
  const id = `f_${field.name}`;
  let control = '';

  if (field.type === 'text' || field.type === 'email') {
    control = `<input type="text" id="${id}" name="${field.name}" required>`;
  } else if (field.type === 'textarea') {
    control = `<textarea id="${id}" name="${field.name}" required></textarea>`;
  } else if (field.type === 'select') {
    const opts = field.options.map((o) => `<option value="${o}">${o}</option>`).join('');
    control = `<select id="${id}" name="${field.name}" required><option value="" disabled selected>Select…</option>${opts}</select>`;
  } else if (field.type === 'radio') {
    control = `<div class="radio-group">${field.options
      .map((o) => `<label><input type="radio" name="${field.name}" value="${o}" required> ${o}</label>`)
      .join('')}</div>`;
  } else if (field.type === 'checkbox-group') {
    control = `<div class="checkbox-group">${field.options
      .map((o) => `<label><input type="checkbox" name="${field.name}" value="${o}"> ${o}</label>`)
      .join('')}</div>`;
  }

  let reveal = '';
  if (field.special) {
    const revealFields = field.special.reveal.map(fieldMarkup).join('');
    reveal = `<div class="reveal" data-reveal-for="${field.name}" data-show-on="${field.special.showOn}" hidden>${revealFields}</div>`;
  }

  return `<div class="field" data-field="${field.name}">
    <label for="${id}">${field.label}</label>
    ${control}
    ${reveal}
  </div>`;
}

export function renderForm(container, formDef) {
  container.innerHTML = formDef.fields.map(fieldMarkup).join('');

  container.querySelectorAll('[data-reveal-for]').forEach((revealEl) => {
    const fieldName = revealEl.dataset.revealFor;
    const showOn = revealEl.dataset.showOn;
    const inputs = container.querySelectorAll(`[name="${fieldName}"]`);
    inputs.forEach((input) => {
      input.addEventListener('change', () => {
        const checked = container.querySelector(`[name="${fieldName}"]:checked`);
        const isShown = checked && checked.value === showOn;
        revealEl.hidden = !isShown;
        revealEl.querySelectorAll('input, textarea, select').forEach((el) => {
          el.required = isShown;
          if (!isShown) el.value = '';
        });
      });
    });
  });
}

export function validateForm(container) {
  return !container.querySelector(':invalid');
}

export function collectAnswers(container, formDef) {
  const answers = {};

  function readField(field) {
    if (field.type === 'checkbox-group') {
      const checked = Array.from(container.querySelectorAll(`[name="${field.name}"]:checked`)).map((el) => el.value);
      answers[field.label] = checked.join(', ');
      return;
    }
    if (field.type === 'radio') {
      const checked = container.querySelector(`[name="${field.name}"]:checked`);
      answers[field.label] = checked ? checked.value : '';
    } else {
      const el = container.querySelector(`[name="${field.name}"]`);
      answers[field.label] = el ? el.value : '';
    }

    if (field.special) {
      const revealEl = container.querySelector(`[data-reveal-for="${field.name}"]`);
      if (revealEl && !revealEl.hidden) {
        field.special.reveal.forEach(readField);
      }
    }
  }

  formDef.fields.forEach(readField);
  return answers;
}
