fetch('/api/public/info')
  .then((r) => (r.ok ? r.json() : null))
  .then((info) => {
    if (!info) return;
    for (const el of document.querySelectorAll('[data-school]')) el.textContent = info.school_name;
    document.title = `${info.school_name} NFC Attendance`;
  })
  .catch(() => {});
