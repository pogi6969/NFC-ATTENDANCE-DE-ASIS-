import { createApi, h, clear, toast, fmt, normalizeUid, hasWebNfc, scanOnce, liveEvents, downloadBlob, store } from '/assets/core.js';

const api = createApi('nfc.admin.token');
const root = document.getElementById('root');
const state = { user: null, info: null, stopLive: null, liveHandlers: {} };

api.onUnauthorized = () => {
  state.user = null;
  showLogin();
};

// ---------- Small building blocks ----------

function field(label, input, hint) {
  return h('div', { class: 'field' }, h('label', null, label, input), hint ? h('div', { class: 'hint' }, hint) : null);
}

function select(name, options, value) {
  return h(
    'select',
    { name, value },
    options.map((o) => (Array.isArray(o) ? h('option', { value: o[0] }, o[1]) : h('option', { value: o }, o))),
  );
}

function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return out;
}

function badge(text, kind) {
  return h('span', { class: `badge badge-${kind || String(text).toLowerCase()}` }, text);
}

function dirBadge(direction) {
  return badge(direction, direction === 'IN' ? 'in' : 'out');
}

function table(headers, rows, emptyText = 'Nothing here yet.') {
  if (!rows.length) return h('div', { class: 'table-wrap' }, h('div', { class: 'empty' }, emptyText));
  return h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, headers.map((x) => h('th', null, x)))), h('tbody', null, rows)));
}

function modal(title, body, actions) {
  const dlg = h('dialog', null, h('h2', null, title), body, actions ? h('div', { class: 'dialog-actions' }, actions) : null);
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  return dlg;
}

// Form in a dialog. onSubmit returns true (or nothing) to close, false to keep it open.
function formModal(title, fields, submitLabel, onSubmit) {
  const form = h('form', { method: 'dialog' }, fields);
  const cancel = h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancel');
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, submitLabel);
  form.append(h('div', { class: 'dialog-actions' }, cancel, submit));
  const dlg = modal(title, form, null);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    try {
      const keep = await onSubmit(formData(form), form);
      if (keep !== false) dlg.close();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      submit.disabled = false;
    }
  });
  const first = form.querySelector('input, select, textarea');
  if (first) first.focus();
  return dlg;
}

function confirmBox(title, text, okLabel = 'Delete') {
  return new Promise((resolve) => {
    let ok = false;
    const dlg = modal(title, h('p', null, text), [
      h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'),
      h('button', { class: 'btn btn-primary', onclick: () => { ok = true; dlg.close(); } }, okLabel),
    ]);
    dlg.addEventListener('close', () => resolve(ok));
  });
}

async function run(fn, okMessage) {
  try {
    const r = await fn();
    if (okMessage) toast(okMessage, 'ok');
    return r;
  } catch (err) {
    toast(err.message, 'error');
    return undefined;
  }
}

async function download(path, name) {
  await run(async () => {
    const res = await api.request('GET', path, undefined, { raw: true });
    downloadBlob(await res.blob(), name);
  });
}

// Card UID input that also works with USB readers (they type the number) and phone NFC.
function cardInput(name = 'uid', value = '') {
  const input = h('input', { name, value, placeholder: 'e.g. 04A23B91', autocomplete: 'off', class: 'mono' });
  const wrap = h('div', { class: 'row' }, h('div', { class: 'grow' }, input));
  if (hasWebNfc()) {
    const btn = h('button', { type: 'button', class: 'btn' }, 'Scan with phone');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Hold card to phone…';
      const ctrl = new AbortController();
      try {
        input.value = await scanOnce(ctrl.signal);
        toast('Card read.', 'ok');
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        ctrl.abort();
        btn.disabled = false;
        btn.textContent = 'Scan with phone';
      }
    });
    wrap.append(btn);
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.form?.requestSubmit();
    }
  });
  return { input, wrap };
}

// ---------- Login and layout ----------

function showLogin() {
  if (state.stopLive) state.stopLive();
  const form = h(
    'form',
    null,
    field('Username', h('input', { name: 'username', autocomplete: 'username', required: true })),
    field('Password', h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
    h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Sign in'),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api.post('/api/auth/login', formData(form));
      if (r.user.role === 'parent') {
        location.href = '/app/';
        return;
      }
      api.setToken(r.token);
      state.user = r.user;
      start();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  clear(
    root,
    h(
      'div',
      { class: 'login-wrap' },
      h(
        'div',
        { class: 'card' },
        h('a', { class: 'brand', href: '/' }, h('img', { src: '/icons/logo.svg', alt: '' }), h('span', null, `${state.info?.school_name || ''} NFC Attendance`)),
        h('h1', null, 'School sign in'),
        form,
        h('p', { class: 'small muted' }, 'Parents: use the ', h('a', { href: '/app/' }, 'parent app'), '.'),
      ),
    ),
  );
}

const PAGES = [
  ['overview', 'Today', 'staff'],
  ['students', 'Students', 'staff'],
  ['attendance', 'Attendance log', 'staff'],
  ['reports', 'Daily report', 'staff'],
  ['cards', 'Cards', 'staff'],
  ['notifications', 'Messages', 'staff'],
  ['devices', 'Gate readers', 'admin'],
  ['users', 'Accounts', 'admin'],
  ['settings', 'Settings', 'admin'],
];

let main;
let side;

function layout() {
  const nav = h(
    'nav',
    { class: 'nav' },
    PAGES.filter(([, , role]) => role === 'staff' || state.user.role === 'admin').map(([key, label]) => h('a', { href: `#/${key}`, 'data-page': key }, label)),
  );
  side = h(
    'aside',
    { class: 'side' },
    h('a', { class: 'brand', href: '#/overview' }, h('img', { src: '/icons/logo.svg', alt: '' }), h('span', null, state.info.school_name)),
    nav,
    h(
      'div',
      { class: 'side-foot' },
      h('div', null, h('b', null, state.user.name || state.user.username)),
      h('div', null, state.user.username, ' · ', state.user.role === 'admin' ? 'admin' : 'staff'),
      h('p', null, h('a', { href: '#/password' }, 'Change password'), ' · ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); api.setToken(null); showLogin(); } }, 'Sign out')),
      h('p', null, h('a', { href: '/app/#gate', target: '_blank' }, 'Open gate screen')),
    ),
  );
  main = h('main', { class: 'main' });
  clear(root, h('div', { class: 'layout' }, side, main));
}

function pageHead(title, ...actions) {
  return h(
    'div',
    { class: 'page-head' },
    h('div', { class: 'row' }, h('button', { class: 'btn btn-small menu-btn', onclick: () => side.classList.toggle('open') }, 'Menu'), h('h1', null, title)),
    h('div', { class: 'row' }, actions),
  );
}

async function route() {
  if (!state.user) return;
  side.classList.remove('open');
  const [page, arg] = location.hash.replace(/^#\/?/, '').split('/');
  for (const a of side.querySelectorAll('.nav a')) a.classList.toggle('on', a.dataset.page === (page === 'student' ? 'students' : page || 'overview'));
  state.liveHandlers = {};
  const render = {
    overview: pageOverview,
    students: pageStudents,
    student: () => pageStudent(Number(arg)),
    attendance: pageAttendance,
    reports: pageReports,
    cards: pageCards,
    notifications: pageNotifications,
    devices: pageDevices,
    users: pageUsers,
    settings: pageSettings,
    password: pagePassword,
  }[page || 'overview'];
  clear(main, h('p', { class: 'muted' }, 'Loading…'));
  try {
    await (render || pageOverview)();
  } catch (err) {
    clear(main, pageHead('Error'), h('div', { class: 'card' }, err.message));
  }
}

async function start() {
  state.info = await api.get('/api/public/info');
  fmt.tz = state.info.timezone;
  if (!state.user) {
    if (!api.token()) return showLogin();
    try {
      state.user = (await api.get('/api/auth/me')).user;
    } catch {
      return showLogin();
    }
  }
  if (state.user.role === 'parent') {
    location.href = '/app/';
    return;
  }
  layout();
  if (state.stopLive) state.stopLive();
  state.stopLive = liveEvents(api, {
    attendance: (log) => state.liveHandlers.attendance?.(log),
    'unknown-card': (card) => {
      toast(`Unregistered card tapped: ${card.uid}${card.device_name ? ` at ${card.device_name}` : ''}`);
      state.liveHandlers.unknown?.(card);
    },
  });
  window.onhashchange = route;
  route();
}

// ---------- Today ----------

function feedItem(log, fresh) {
  return h(
    'li',
    { class: fresh ? 'fresh' : '' },
    h('div', { class: 'dir' }, dirBadge(log.direction)),
    h('div', { class: 'who' }, h('b', null, h('a', { href: `#/student/${log.student_id}` }, log.student_name)), h('span', { class: 'small muted' }, [log.grade, log.section].filter(Boolean).join(' · '))),
    h('div', { class: 'when' }, h('b', null, fmt.time(log.at)), h('div', { class: 'small muted' }, log.device_name || (log.method === 'manual' ? 'Manual' : ''))),
  );
}

async function pageOverview() {
  const d = await api.get('/api/dashboard');
  const stat = (n, label, cls = '') => h('div', { class: `stat ${cls}` }, h('b', null, n), h('span', null, label));
  const stats = h(
    'div',
    { class: 'stats' },
    stat(d.enrolled, 'Students'),
    stat(d.present, 'Present today', 'in'),
    stat(d.on_campus, 'On campus now', 'in'),
    stat(d.left, 'Already left', 'out'),
    stat(d.late, 'Late', 'out'),
    stat(d.absent, 'Not yet in / absent', 'bad'),
  );
  const feed = h('ul', { class: 'feed' }, d.recent.map((l) => feedItem(l)));
  const emptyFeed = h('div', { class: 'empty' }, 'No taps yet today. They will appear here live.');
  emptyFeed.hidden = d.recent.length > 0;

  const alerts = [];
  if (d.unknown_cards) alerts.push(h('p', null, badge(String(d.unknown_cards), 'bad'), ' unregistered card(s) were tapped. ', h('a', { href: '#/cards' }, 'Assign them')));
  if (d.failed_notifications) alerts.push(h('p', null, badge(String(d.failed_notifications), 'bad'), ' message(s) failed in the last 24 hours. ', h('a', { href: '#/notifications' }, 'See messages')));

  const devices = d.devices.length
    ? h('ul', { class: 'feed' }, d.devices.map((dev) => h('li', null, h('div', { class: 'who' }, h('b', null, dev.name), h('span', { class: 'small muted' }, `${dev.location || ''} ${dev.mode !== 'auto' ? `· ${dev.mode.toUpperCase()} only` : ''}`)), h('div', { class: 'when small muted' }, dev.active ? `Seen ${fmt.ago(dev.last_seen_at)}` : 'Turned off'))))
    : h('p', { class: 'muted' }, 'No gate readers yet. ', state.user.role === 'admin' ? h('a', { href: '#/devices' }, 'Add one') : '');

  clear(
    main,
    pageHead(`Today · ${fmt.date(d.date)}`, h('a', { class: 'btn', href: '#/reports' }, 'Daily report')),
    stats,
    h('p', null, ' '),
    h(
      'div',
      { class: 'two-col' },
      h('div', { class: 'card' }, h('h2', null, 'Live taps'), emptyFeed, feed),
      h('div', { class: 'stack' }, alerts.length ? h('div', { class: 'card' }, h('h2', null, 'Needs attention'), alerts) : null, h('div', { class: 'card' }, h('h2', null, 'Gate readers'), devices)),
    ),
  );
  state.liveHandlers.attendance = (log) => {
    emptyFeed.hidden = true;
    feed.prepend(feedItem(log, true));
    while (feed.children.length > 30) feed.lastChild.remove();
    clearTimeout(state.refresh);
    state.refresh = setTimeout(async () => {
      const fresh = await api.get('/api/dashboard').catch(() => null);
      if (!fresh || !stats.isConnected) return;
      const values = [fresh.enrolled, fresh.present, fresh.on_campus, fresh.left, fresh.late, fresh.absent];
      [...stats.children].forEach((el, i) => (el.firstChild.textContent = values[i]));
    }, 800);
  };
}

// ---------- Students ----------

function studentForm(s = {}) {
  return [
    h('div', { class: 'grid-2' },
      field('Student number', h('input', { name: 'student_no', value: s.student_no || '', required: true })),
      field('Card ID (optional)', cardInput('card_uid', s.card_uid || '').wrap),
      field('First name', h('input', { name: 'first_name', value: s.first_name || '', required: true })),
      field('Last name', h('input', { name: 'last_name', value: s.last_name || '', required: true })),
      field('Grade', h('input', { name: 'grade', value: s.grade || '', placeholder: 'e.g. Grade 10' })),
      field('Section', h('input', { name: 'section', value: s.section || '', placeholder: 'e.g. Rizal' })),
    ),
  ];
}

function guardianForm(g = {}) {
  return [
    field('Name', h('input', { name: 'name', value: g.name || '', required: true })),
    h('div', { class: 'grid-2' },
      field('Relationship', h('input', { name: 'relationship', value: g.relationship || '', placeholder: 'Mother, Father, Guardian…' })),
      field('Mobile number', h('input', { name: 'phone', type: 'tel', value: g.phone || '', required: true, placeholder: '0917 123 4567' })),
    ),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'notify_sms', checked: g.notify_sms === undefined ? true : !!g.notify_sms }), 'Send a text message on every entry and exit'),
  ];
}

async function pageStudents() {
  const meta = await api.get('/api/students/meta');
  const params = new URLSearchParams(store.get('nfc.admin.studentFilter') || '');
  const q = h('input', { type: 'search', placeholder: 'Search name, student no. or card', value: params.get('q') || '' });
  const grade = select('grade', [['', 'All grades'], ...meta.grades], params.get('grade') || '');
  const section = select('section', [['', 'All sections'], ...meta.sections], params.get('section') || '');
  const status = select('status', [['active', 'Active'], ['inactive', 'Turned off'], ['all', 'All']], params.get('status') || 'active');
  const out = h('div');

  async function load() {
    const p = new URLSearchParams({ q: q.value.trim(), grade: grade.value, section: section.value, status: status.value });
    store.set('nfc.admin.studentFilter', p.toString());
    const { students } = await api.get(`/api/students?${p}`);
    clear(
      out,
      h('p', { class: 'small muted' }, `${students.length} student(s)`),
      table(
        ['Student no.', 'Name', 'Grade / section', 'Card', 'Parents', 'Today'],
        students.map((s) =>
          h(
            'tr',
            { class: 'click', onclick: () => (location.hash = `#/student/${s.id}`) },
            h('td', { class: 'mono' }, s.student_no),
            h('td', null, h('b', null, `${s.last_name}, ${s.first_name}`), s.active ? null : [' ', badge('Off', 'bad')]),
            h('td', null, [s.grade, s.section].filter(Boolean).join(' · ')),
            h('td', null, s.card_uid ? h('span', { class: 'mono small' }, s.card_uid) : badge('No card', 'bad')),
            h('td', null, s.guardian_count ? String(s.guardian_count) : badge('None', 'bad')),
            h('td', null, s.today_last ? badge(s.today_last === 'IN' ? 'On campus' : 'Left', s.today_last === 'IN' ? 'in' : 'out') : h('span', { class: 'muted' }, '—')),
          ),
        ),
        'No students match. Add one or import a CSV file.',
      ),
    );
  }

  let timer;
  q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(load, 250);
  });
  for (const el of [grade, section, status]) el.addEventListener('change', load);

  const addBtn = h('button', { class: 'btn btn-primary', onclick: () => {
    formModal('Add student', studentForm(), 'Add student', async (data) => {
      const r = await api.post('/api/students', data);
      toast('Student added.', 'ok');
      location.hash = `#/student/${r.student.id}`;
    });
  } }, 'Add student');
  const importBtn = state.user.role === 'admin' ? h('button', { class: 'btn', onclick: importDialog }, 'Import CSV') : null;

  clear(main, pageHead('Students', importBtn, addBtn), h('div', { class: 'toolbar' }, q, grade, section, status), out);
  await load();
}

function importDialog() {
  const file = h('input', { type: 'file', accept: '.csv,text/csv' });
  const result = h('div');
  const go = h('button', { class: 'btn btn-primary' }, 'Import');
  const dlg = modal(
    'Import students from CSV',
    h('div', null,
      h('p', { class: 'small' }, 'Save your class list from Excel or Google Sheets as CSV. The first row must have these column names:'),
      h('p', { class: 'keybox small' }, 'student_no, first_name, last_name, grade, section, card_uid, guardian_name, guardian_relationship, guardian_phone'),
      h('p', { class: 'small muted' }, 'Only student_no, first_name and last_name are required. Existing student numbers are updated.'),
      field('CSV file', file),
      h('p', null, h('a', { href: '#', onclick: (e) => { e.preventDefault(); downloadBlob(new Blob(['student_no,first_name,last_name,grade,section,card_uid,guardian_name,guardian_relationship,guardian_phone\r\n2026-0001,Juan,Dela Cruz,Grade 10,Rizal,04A23B91,Maria Dela Cruz,Mother,09171234567\r\n'], { type: 'text/csv' }), 'students_template.csv'); } }, 'Download a template')),
      result,
    ),
    [h('button', { class: 'btn', onclick: () => dlg.close() }, 'Close'), go],
  );
  go.addEventListener('click', async () => {
    if (!file.files[0]) return toast('Choose a CSV file first.', 'error');
    go.disabled = true;
    const r = await run(async () => api.post('/api/students/import', { csv: await file.files[0].text() }));
    go.disabled = false;
    if (!r) return;
    clear(result,
      h('p', null, h('b', null, `${r.created} added, ${r.updated} updated, ${r.cards} card(s), ${r.guardians} parent number(s).`)),
      r.errors.length ? h('div', null, h('p', { class: 'small' }, `${r.errors.length} row(s) had problems:`), h('ul', { class: 'small' }, r.errors.slice(0, 50).map((e) => h('li', null, `Line ${e.line}: ${e.error}`)))) : null,
    );
    if (location.hash.startsWith('#/students')) route();
  });
}

async function pageStudent(sid) {
  const d = await api.get(`/api/students/${sid}`);
  const s = d.student;
  const isAdmin = state.user.role === 'admin';

  const edit = () =>
    formModal('Edit student', [...studentForm(s).map((x) => { x.querySelector('[name=card_uid]')?.closest('.field').remove(); return x; }), h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'active', checked: !!s.active }), 'Active (card works at the gate)')], 'Save', async (data) => {
      await api.put(`/api/students/${sid}`, data);
      toast('Saved.', 'ok');
      route();
    });

  const assignCard = () => {
    const { wrap } = cardInput('uid', '');
    formModal(s.card_uid ? 'Replace card' : 'Assign card', [h('p', { class: 'small muted' }, 'Tap the card on a USB reader with the box selected, scan it with this phone, or type the card ID.'), field('Card ID', wrap)], 'Save card', async (data) => {
      try {
        await api.put(`/api/students/${sid}/card`, { uid: data.uid });
      } catch (err) {
        if (err.status !== 409) throw err;
        if (!(await confirmBox('Card already in use', `${err.message} Move it to ${s.first_name}?`, 'Move card'))) return false;
        await api.put(`/api/students/${sid}/card`, { uid: data.uid, force: true });
      }
      toast('Card saved.', 'ok');
      route();
    });
  };

  const removeCard = async () => {
    if (!(await confirmBox('Remove card', `Remove card ${s.card_uid} from ${s.first_name}? The card will stop working.`, 'Remove'))) return;
    await run(() => api.put(`/api/students/${sid}/card`, { uid: null }), 'Card removed.');
    route();
  };

  const record = (direction) =>
    formModal(`Record ${direction === 'IN' ? 'entry' : 'exit'} for ${s.first_name}`, [
      field('Time', h('input', { type: 'datetime-local', name: 'at' }), 'Leave empty for now.'),
      field('Note', h('input', { name: 'note', placeholder: 'e.g. Forgot ID card' })),
      h('p', { class: 'small muted' }, 'Parents are notified the same way as a card tap.'),
    ], 'Record', async (data) => {
      await api.post('/api/attendance/manual', { student_id: sid, direction, at: data.at ? new Date(data.at).toISOString() : undefined, note: data.note });
      toast('Recorded.', 'ok');
      route();
    });

  const guardianRow = (g) =>
    h('li', null,
      h('div', { class: 'who' },
        h('b', null, g.name, g.relationship ? h('span', { class: 'muted' }, ` · ${g.relationship}`) : null),
        h('span', { class: 'small' }, g.phone, ' · ', g.notify_sms ? 'Texts on' : 'Texts off'),
        h('div', { class: 'small muted' }, 'App code: ', h('span', { class: 'mono' }, g.invite_code)),
      ),
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-small', onclick: async () => {
          const r = await run(() => api.post(`/api/guardians/${g.id}/invite`));
          if (r) toast(r.ok ? `App invite texted to ${g.phone}.` : `Text failed: ${r.error}`, r.ok ? 'ok' : 'error');
        } }, 'Text app invite'),
        h('button', { class: 'btn btn-small', onclick: () => formModal('Edit parent / guardian', guardianForm(g), 'Save', async (data) => { await api.put(`/api/guardians/${g.id}`, data); toast('Saved.', 'ok'); route(); }) }, 'Edit'),
        h('button', { class: 'btn btn-small', onclick: async () => { await run(() => api.post(`/api/guardians/${g.id}/code`), 'New app code made.'); route(); } }, 'New code'),
        h('button', { class: 'btn btn-small btn-danger', onclick: async () => {
          if (await confirmBox('Remove parent', `Remove ${g.name} from ${s.first_name}? They will stop getting messages.`, 'Remove')) {
            await run(() => api.del(`/api/guardians/${g.id}`), 'Removed.');
            route();
          }
        } }, 'Remove'),
      ),
    );

  const today = d.today;
  const stateText = { not_arrived: 'Not yet arrived today', on_campus: `On campus since ${fmt.time(today.last?.at)}`, left: `Left at ${fmt.time(today.last?.at)}` }[today.state];

  clear(
    main,
    pageHead(`${s.first_name} ${s.last_name}`,
      h('a', { class: 'btn', href: '#/students' }, 'Back'),
      h('button', { class: 'btn', onclick: edit }, 'Edit'),
      isAdmin ? h('button', { class: 'btn btn-danger', onclick: async () => {
        if (await confirmBox('Delete student', `Delete ${s.first_name} ${s.last_name} and all of their attendance records? To keep the records, edit the student and untick Active instead.`)) {
          await run(() => api.del(`/api/students/${sid}`), 'Student deleted.');
          location.hash = '#/students';
        }
      } }, 'Delete') : null,
    ),
    h('div', { class: 'two-col' },
      h('div', { class: 'stack' },
        h('div', { class: 'card' },
          h('div', { class: 'row spread' },
            h('div', null,
              h('div', { class: 'muted small' }, `${s.student_no} · ${[s.grade, s.section].filter(Boolean).join(' · ')}`),
              h('h2', null, stateText, today.late ? [' ', badge('Late', 'late')] : null),
              s.active ? null : badge('Turned off', 'bad'),
            ),
            h('div', { class: 'row' }, h('button', { class: 'btn btn-in', onclick: () => record('IN') }, 'Record IN'), h('button', { class: 'btn btn-out', onclick: () => record('OUT') }, 'Record OUT')),
          ),
        ),
        h('div', { class: 'card' },
          h('h2', null, 'Recent attendance'),
          d.recent.length
            ? h('ul', { class: 'feed' }, d.recent.map((l) => h('li', null, h('div', { class: 'dir' }, dirBadge(l.direction)), h('div', { class: 'who' }, h('b', null, fmt.date(l.local_date)), h('span', { class: 'small muted' }, l.device_name || (l.method === 'manual' ? `Manual${l.recorded_by_name ? ` by ${l.recorded_by_name}` : ''}${l.note ? ` — ${l.note}` : ''}` : ''))), h('div', { class: 'when' }, h('b', null, fmt.time(l.at))))))
            : h('p', { class: 'muted' }, 'No taps yet.'),
        ),
      ),
      h('div', { class: 'stack' },
        h('div', { class: 'card' },
          h('h2', null, 'NFC card'),
          s.card_uid ? h('p', { class: 'mono' }, s.card_uid) : h('p', null, badge('No card assigned', 'bad')),
          h('div', { class: 'row' }, h('button', { class: 'btn btn-primary', onclick: assignCard }, s.card_uid ? 'Replace card' : 'Assign card'), s.card_uid ? h('button', { class: 'btn btn-danger', onclick: removeCard }, 'Remove') : null),
        ),
        h('div', { class: 'card' },
          h('div', { class: 'row spread' }, h('h2', null, 'Parents & guardians'), h('button', { class: 'btn btn-small btn-primary', onclick: () => formModal('Add parent / guardian', guardianForm(), 'Add', async (data) => { await api.post(`/api/students/${sid}/guardians`, data); toast('Added.', 'ok'); route(); }) }, 'Add')),
          d.guardians.length ? h('ul', { class: 'feed wrap' }, d.guardians.map(guardianRow)) : h('p', { class: 'muted' }, 'Add a parent so they get a text when their child enters or leaves.'),
          h('p', { class: 'small muted' }, 'Parents install the app at ', h('span', { class: 'mono' }, `${location.origin}/app/`), ' and activate with their number and app code.'),
        ),
      ),
    ),
  );
}

// ---------- Attendance log ----------

async function pageAttendance() {
  const today = fmt.today();
  const from = h('input', { type: 'date', value: today });
  const to = h('input', { type: 'date', value: today });
  const q = h('input', { type: 'search', placeholder: 'Search student' });
  const dir = select('direction', [['', 'In and out'], ['IN', 'IN only'], ['OUT', 'OUT only']], '');
  const out = h('div');
  const isAdmin = state.user.role === 'admin';

  const params = () => new URLSearchParams({ from: from.value, to: to.value, q: q.value.trim(), direction: dir.value });
  async function load() {
    const { logs } = await api.get(`/api/attendance?${params()}&limit=2000`);
    clear(out,
      h('p', { class: 'small muted' }, `${logs.length} record(s)${logs.length === 2000 ? ' (showing the latest 2000 — export for all)' : ''}`),
      table(['Date', 'Time', '', 'Student', 'Grade / section', 'Gate', isAdmin ? '' : null].filter((x) => x !== null),
        logs.map((l) => h('tr', null,
          h('td', null, l.local_date),
          h('td', null, h('b', null, fmt.time(l.at))),
          h('td', null, dirBadge(l.direction)),
          h('td', null, h('a', { href: `#/student/${l.student_id}` }, `${l.last_name}, ${l.first_name}`), h('div', { class: 'small muted mono' }, l.student_no)),
          h('td', null, [l.grade, l.section].filter(Boolean).join(' · ')),
          h('td', null, l.device_name || (l.method === 'manual' ? `Manual${l.recorded_by_name ? ` (${l.recorded_by_name})` : ''}` : ''), l.note ? h('div', { class: 'small muted' }, l.note) : null),
          isAdmin ? h('td', null, h('button', { class: 'btn btn-small btn-danger', onclick: async () => {
            if (await confirmBox('Delete record', `Delete the ${l.direction} record of ${l.student_name} at ${fmt.time(l.at)}?`)) {
              await run(() => api.del(`/api/attendance/${l.id}`), 'Deleted.');
              load();
            }
          } }, 'Delete')) : null,
        )),
        'No attendance in this period.'),
    );
  }
  let timer;
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
  for (const el of [from, to, dir]) el.addEventListener('change', load);
  clear(main,
    pageHead('Attendance log', h('button', { class: 'btn', onclick: () => download(`/api/attendance/export?${params()}`, `attendance_${from.value}_${to.value}.csv`) }, 'Export CSV')),
    h('div', { class: 'toolbar' }, field('From', from), field('To', to), field('Show', dir), field('Student', q)),
    out,
  );
  state.liveHandlers.attendance = () => { if (to.value >= fmt.today()) load(); };
  await load();
}

// ---------- Daily report ----------

async function pageReports() {
  const meta = await api.get('/api/students/meta');
  const date = h('input', { type: 'date', value: fmt.today() });
  const grade = select('grade', [['', 'All grades'], ...meta.grades], '');
  const section = select('section', [['', 'All sections'], ...meta.sections], '');
  const show = select('show', [['', 'Everyone'], ['absent', 'Absent'], ['late', 'Late'], ['present', 'Present (on time)'], ['on_campus', 'Still on campus']], '');
  const out = h('div');
  const params = () => new URLSearchParams({ date: date.value, grade: grade.value, section: section.value });

  async function load() {
    const r = await api.get(`/api/reports/daily?${params()}`);
    const rows = r.rows.filter((x) => !show.value || (show.value === 'on_campus' ? x.on_campus : x.status === show.value));
    const stat = (n, label, cls = '') => h('div', { class: `stat ${cls}` }, h('b', null, n), h('span', null, label));
    clear(out,
      h('div', { class: 'stats' }, stat(r.summary.total, 'Students'), stat(r.summary.present, 'Present', 'in'), stat(r.summary.late, 'Late', 'out'), stat(r.summary.absent, 'Absent', 'bad'), stat(r.summary.on_campus, 'No exit tap yet')),
      h('p', null, ' '),
      table(['Student', 'Grade / section', 'Status', 'First in', 'Last out'],
        rows.map((x) => h('tr', { class: 'click', onclick: () => (location.hash = `#/student/${x.id}`) },
          h('td', null, h('b', null, `${x.last_name}, ${x.first_name}`), h('div', { class: 'small muted mono' }, x.student_no)),
          h('td', null, [x.grade, x.section].filter(Boolean).join(' · ')),
          h('td', null, badge(x.status[0].toUpperCase() + x.status.slice(1), x.status)),
          h('td', null, x.first_in ? fmt.time(x.first_in) : '—'),
          h('td', null, x.last_out ? fmt.time(x.last_out) : x.on_campus ? badge('On campus', 'in') : '—'),
        )),
        'No students for this filter.'),
    );
  }
  for (const el of [date, grade, section, show]) el.addEventListener('change', load);
  clear(main,
    pageHead('Daily report', h('button', { class: 'btn', onclick: () => download(`/api/reports/daily?${params()}&format=csv`, `daily_report_${date.value}.csv`) }, 'Export CSV')),
    h('div', { class: 'toolbar' }, field('Date', date), field('Grade', grade), field('Section', section), field('Show', show)),
    out,
  );
  state.liveHandlers.attendance = () => { if (date.value === fmt.today()) load(); };
  await load();
}

// ---------- Cards ----------

async function pageCards() {
  const out = h('div');
  const check = cardInput('uid', '');
  const lookupResult = h('div');
  const lookupForm = h('form', { class: 'row' }, h('div', { class: 'grow' }, check.wrap), h('button', { class: 'btn btn-primary', type: 'submit' }, 'Check'));
  lookupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await run(() => api.get(`/api/cards/lookup?uid=${encodeURIComponent(check.input.value)}`));
    if (!r) return;
    clear(lookupResult, h('p', null, h('span', { class: 'mono' }, r.uid), ' → ', r.student ? h('a', { href: `#/student/${r.student.id}` }, `${r.student.name} (${r.student.student_no})`) : badge('Not registered', 'bad')));
    check.input.select();
  });

  async function assign(uid) {
    const search = h('input', { type: 'search', placeholder: 'Type a name or student number' });
    const list = h('div');
    const dlg = modal(`Assign card ${uid}`, h('div', null, field('Student', search), list), [h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel')]);
    let timer;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (!search.value.trim()) return clear(list);
        const { students } = await api.get(`/api/students?q=${encodeURIComponent(search.value.trim())}`);
        clear(list, h('ul', { class: 'feed' }, students.slice(0, 12).map((s) => h('li', null,
          h('div', { class: 'who' }, h('b', null, `${s.last_name}, ${s.first_name}`), h('span', { class: 'small muted' }, `${s.student_no} · ${s.card_uid ? `has card ${s.card_uid}` : 'no card'}`)),
          h('button', { class: 'btn btn-small btn-primary', onclick: async () => {
            try {
              await api.put(`/api/students/${s.id}/card`, { uid, force: true });
              toast(`Card assigned to ${s.first_name}.`, 'ok');
              dlg.close();
              load();
            } catch (err) { toast(err.message, 'error'); }
          } }, s.card_uid ? 'Replace' : 'Assign'),
        ))));
      }, 250);
    });
    search.focus();
  }

  async function load() {
    const { cards } = await api.get('/api/cards/unknown');
    clear(out, table(['Card ID', 'Last tapped', 'Times', 'Gate', ''],
      cards.map((c) => h('tr', null,
        h('td', { class: 'mono' }, c.card_uid),
        h('td', null, fmt.dateTime(c.last_at)),
        h('td', null, String(c.count)),
        h('td', null, c.device_name || ''),
        h('td', null, h('div', { class: 'row' }, h('button', { class: 'btn btn-small btn-primary', onclick: () => assign(c.card_uid) }, 'Assign'), h('button', { class: 'btn btn-small', onclick: async () => { await run(() => api.del(`/api/cards/unknown/${c.card_uid}`)); load(); } }, 'Dismiss'))),
      )),
      'No unregistered cards. When a new card is tapped at a gate it shows up here, ready to assign.'));
  }
  clear(main,
    pageHead('Cards'),
    h('div', { class: 'card' }, h('h2', null, 'Check a card'), h('p', { class: 'small muted' }, 'Find out who owns a card. Click the box and tap the card on a USB reader, or scan it with this phone.'), lookupForm, lookupResult),
    h('h2', null, ' '),
    h('h2', null, 'Unregistered cards tapped at the gate'),
    out,
  );
  state.liveHandlers.unknown = load;
  await load();
}

// ---------- Messages ----------

async function pageNotifications() {
  const status = select('status', [['', 'All'], ['sent', 'Sent'], ['failed', 'Failed'], ['pending', 'Sending']], '');
  const channel = select('channel', [['', 'Text and app'], ['sms', 'Text (SMS)'], ['push', 'App notification']], '');
  const out = h('div');
  async function load() {
    const { notifications } = await api.get(`/api/notifications?${new URLSearchParams({ status: status.value, channel: channel.value })}`);
    clear(out, table(['Time', 'To', 'Type', 'Message', 'Status', ''],
      notifications.map((n) => h('tr', null,
        h('td', null, fmt.dateTime(n.created_at)),
        h('td', null, n.recipient, n.student_name ? h('div', { class: 'small muted' }, n.student_name) : null),
        h('td', null, n.channel === 'sms' ? 'Text' : 'App', n.kind !== 'attendance' ? h('div', { class: 'small muted' }, n.kind) : null),
        h('td', { class: 'small' }, n.message),
        h('td', null, badge(n.status, n.status), n.error ? h('div', { class: 'small muted' }, n.error) : null),
        h('td', null, n.status === 'failed' ? h('button', { class: 'btn btn-small', onclick: async () => {
          const r = await run(() => api.post(`/api/notifications/${n.id}/resend`));
          if (r) toast(r.ok ? 'Sent.' : `Failed again: ${r.error}`, r.ok ? 'ok' : 'error');
          load();
        } }, 'Resend') : null),
      )),
      'No messages yet.'));
  }
  for (const el of [status, channel]) el.addEventListener('change', load);
  clear(main, pageHead('Messages to parents'), h('div', { class: 'toolbar' }, status, channel), out);
  state.liveHandlers.attendance = () => setTimeout(load, 1500);
  await load();
}

// ---------- Gate readers ----------

function showKey(device, key) {
  const link = `${location.origin}/app/#gate/pair/${key}`;
  const dlg = modal(`Pair "${device.name}"`, h('div', null,
    h('p', null, 'Open this link on the gate phone or tablet (Chrome on Android for NFC):'),
    h('p', { class: 'keybox' }, link),
    h('p', null, 'For the ESP32 reader or the USB bridge, use this reader key:'),
    h('p', { class: 'keybox' }, key),
    h('p', { class: 'small muted' }, 'The key is shown only once. You can make a new one at any time.'),
  ), [
    h('button', { class: 'btn', onclick: () => navigator.clipboard?.writeText(link).then(() => toast('Link copied.', 'ok')) }, 'Copy link'),
    h('button', { class: 'btn btn-primary', onclick: () => dlg.close() }, 'Done'),
  ]);
}

async function pageDevices() {
  const { devices } = await api.get('/api/devices');
  const modes = [['auto', 'Auto: first tap IN, next tap OUT'], ['in', 'Entrance only (always IN)'], ['out', 'Exit only (always OUT)']];
  const form = (d = {}) => [
    field('Name', h('input', { name: 'name', value: d.name || '', required: true, placeholder: 'Main Gate' })),
    field('Location', h('input', { name: 'location', value: d.location || '', placeholder: 'Front entrance' })),
    field('Mode', select('mode', modes, d.mode || 'auto')),
    d.id ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'active', checked: !!d.active }), 'Turned on') : null,
  ];
  clear(main,
    pageHead('Gate readers', h('button', { class: 'btn btn-primary', onclick: () => formModal('Add gate reader', form(), 'Add reader', async (data) => {
      const r = await api.post('/api/devices', data);
      showKey(r.device, r.key);
      route();
    }) }, 'Add reader')),
    table(['Name', 'Mode', 'Key', 'Last seen', ''],
      devices.map((d) => h('tr', null,
        h('td', null, h('b', null, d.name), d.location ? h('div', { class: 'small muted' }, d.location) : null, d.active ? null : badge('Off', 'bad')),
        h('td', null, { auto: 'Auto', in: 'IN only', out: 'OUT only' }[d.mode]),
        h('td', { class: 'mono small' }, `…${d.key_hint}`),
        h('td', null, fmt.ago(d.last_seen_at)),
        h('td', null, h('div', { class: 'row' },
          h('button', { class: 'btn btn-small', onclick: () => formModal('Edit gate reader', form(d), 'Save', async (data) => { await api.put(`/api/devices/${d.id}`, data); toast('Saved.', 'ok'); route(); }) }, 'Edit'),
          h('button', { class: 'btn btn-small', onclick: async () => {
            if (!(await confirmBox('New key', `Make a new key for ${d.name}? The reader must be paired again.`, 'Make new key'))) return;
            const r = await run(() => api.post(`/api/devices/${d.id}/key`));
            if (r) showKey(r.device, r.key);
          } }, 'Pair again'),
          h('button', { class: 'btn btn-small btn-danger', onclick: async () => {
            if (await confirmBox('Delete reader', `Delete ${d.name}? Its past taps stay in the log.`)) { await run(() => api.del(`/api/devices/${d.id}`), 'Deleted.'); route(); }
          } }, 'Delete'),
        )),
      )),
      'No readers yet. Add one for each gate, then open its pairing link on the gate phone.'),
  );
}

// ---------- Accounts ----------

async function pageUsers() {
  const { users } = await api.get('/api/users');
  const staffForm = (u = {}) => [
    u.id ? null : field('Username', h('input', { name: 'username', required: true, autocomplete: 'off' })),
    field('Name', h('input', { name: 'name', value: u.name || '', required: true })),
    u.role === 'parent' ? null : field('Role', select('role', [['staff', 'Staff — students, cards, attendance'], ['admin', 'Administrator — everything']], u.role || 'staff')),
    field(u.id ? 'New password (optional)' : 'Password', h('input', { name: 'password', type: 'password', autocomplete: 'new-password', required: !u.id, minlength: 8 }), 'At least 8 characters.'),
    u.id ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'active', checked: !!u.active }), 'Can sign in') : null,
  ];
  const roleName = { admin: 'Administrator', staff: 'Staff', parent: 'Parent' };
  clear(main,
    pageHead('Accounts', h('button', { class: 'btn btn-primary', onclick: () => formModal('Add staff account', staffForm(), 'Add', async (data) => { await api.post('/api/users', data); toast('Account added.', 'ok'); route(); }) }, 'Add staff')),
    h('p', { class: 'muted small' }, 'Parent accounts are made when a parent activates the app with their code.'),
    table(['Name', 'Username / number', 'Role', 'Last sign in', 'App alerts', ''],
      users.map((u) => h('tr', null,
        h('td', null, h('b', null, u.name || '—'), u.active ? null : [' ', badge('Off', 'bad')]),
        h('td', { class: 'mono small' }, u.username),
        h('td', null, roleName[u.role]),
        h('td', null, fmt.ago(u.last_login_at)),
        h('td', null, u.push_devices ? badge(`${u.push_devices} phone(s)`, 'in') : '—'),
        h('td', null, h('div', { class: 'row' },
          h('button', { class: 'btn btn-small', onclick: () => formModal(`Edit ${u.name || u.username}`, staffForm(u), 'Save', async (data) => { if (!data.password) delete data.password; await api.put(`/api/users/${u.id}`, data); toast('Saved.', 'ok'); route(); }) }, 'Edit'),
          u.id !== state.user.id ? h('button', { class: 'btn btn-small btn-danger', onclick: async () => {
            if (await confirmBox('Delete account', `Delete the account ${u.username}?`)) { await run(() => api.del(`/api/users/${u.id}`), 'Deleted.'); route(); }
          } }, 'Delete') : null,
        )),
      ))),
  );
}

// ---------- Settings ----------

async function pageSettings() {
  const { settings: s, sms } = await api.get('/api/settings');
  const box = (name, label, checked) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name, checked }), label);
  const form = h('form', null,
    h('div', { class: 'card' },
      h('h2', null, 'School'),
      h('div', { class: 'grid-2' },
        field('School name', h('input', { name: 'school_name', value: s.school_name, required: true }), 'Shown in the app and at the start of each text.'),
        field('Time zone', h('input', { name: 'timezone', value: s.timezone, required: true }), 'e.g. Asia/Manila'),
        field('Late after', h('input', { name: 'late_time', type: 'time', value: s.late_time, required: true }), 'First entry after this time counts as late.'),
        field('Ignore repeat taps for (seconds)', h('input', { name: 'tap_cooldown_seconds', type: 'number', min: 0, max: 3600, value: s.tap_cooldown_seconds }), 'Stops a double tap from counting as IN then OUT.'),
      ),
    ),
    h('p', null, ' '),
    h('div', { class: 'card' },
      h('h2', null, 'Messages to parents'),
      box('sms_enabled', 'Send text messages (SMS)', s.sms_enabled),
      box('push_enabled', 'Send app notifications', s.push_enabled),
      box('notify_on_in', 'Notify when the student enters', s.notify_on_in),
      box('notify_on_out', 'Notify when the student leaves', s.notify_on_out),
      h('p', null, ' '),
      field('Entry message', h('textarea', { name: 'template_in', value: s.template_in, required: true })),
      field('Exit message', h('textarea', { name: 'template_out', value: s.template_out, required: true }),
        'You can use {school} {student} {first_name} {last_name} {grade} {section} {time} {date} {gate}'),
    ),
    h('p', null, ' '),
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save settings'),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = formData(form);
    data.tap_cooldown_seconds = Number(data.tap_cooldown_seconds);
    const r = await run(() => api.put('/api/settings', data), 'Settings saved.');
    if (r) {
      state.info.school_name = r.settings.school_name;
      fmt.tz = state.info.timezone = r.settings.timezone;
    }
  });

  const phone = h('input', { type: 'tel', placeholder: '0917 123 4567' });
  const test = h('form', { class: 'row' }, h('div', { class: 'grow' }, phone), h('button', { class: 'btn', type: 'submit' }, 'Send test text'));
  test.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await run(() => api.post('/api/notifications/test-sms', { phone: phone.value }));
    if (r) toast(r.ok ? 'Test text sent.' : `Failed: ${r.error}`, r.ok ? 'ok' : 'error');
  });
  const providerName = { console: 'Server log only (testing)', semaphore: 'Semaphore', twilio: 'Twilio', webhook: 'Own SMS gateway', none: 'Off' }[sms.provider] || sms.provider;

  clear(main,
    pageHead('Settings'),
    form,
    h('p', null, ' '),
    h('div', { class: 'card' },
      h('h2', null, 'Text message service'),
      h('p', null, 'Provider: ', h('b', null, providerName), ' ', sms.configured ? badge('Ready', 'in') : badge('Not set up', 'bad')),
      h('p', { class: 'small muted' }, 'The provider and its API key are set on the server (SMS_PROVIDER in the .env file). See the README.'),
      test,
    ),
  );
}

async function pagePassword() {
  const form = h('form', { class: 'card' },
    field('Current password', h('input', { type: 'password', name: 'current', required: true, autocomplete: 'current-password' })),
    field('New password', h('input', { type: 'password', name: 'next', required: true, minlength: 8, autocomplete: 'new-password' }), 'At least 8 characters.'),
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Change password'),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await run(() => api.post('/api/auth/password', formData(form)), 'Password changed.');
    if (r) {
      api.setToken(r.token);
      form.reset();
    }
  });
  clear(main, pageHead('Change password'), form);
}

start().catch((err) => clear(root, h('div', { class: 'login-wrap' }, h('div', { class: 'card' }, h('h1', null, 'Cannot reach the server'), h('p', null, err.message), h('button', { class: 'btn', onclick: () => location.reload() }, 'Try again')))));
