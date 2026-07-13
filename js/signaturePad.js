export function initSignaturePad(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#111827';
  let drawing = false;
  let hasInk = false;

  function pointFromEvent(evt) {
    const rect = canvas.getBoundingClientRect();
    const src = evt.touches ? evt.touches[0] : evt;
    return {
      x: ((src.clientX - rect.left) / rect.width) * canvas.width,
      y: ((src.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function start(evt) {
    evt.preventDefault();
    drawing = true;
    const p = pointFromEvent(evt);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  }

  function move(evt) {
    if (!drawing) return;
    evt.preventDefault();
    const p = pointFromEvent(evt);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    hasInk = true;
  }

  function end() {
    drawing = false;
  }

  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  canvas.addEventListener('touchend', end);

  return {
    clear() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      hasInk = false;
    },
    isEmpty() {
      return !hasInk;
    },
    toDataURL() {
      return canvas.toDataURL('image/png');
    },
  };
}
