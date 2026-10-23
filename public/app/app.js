import { createApi, h, clear, toast, fmt, normalizeUid, hasWebNfc, liveEvents, store, ApiError } from '/assets/core.js';

const api = createApi('nfc.parent.token');
const root = document.getElementById('root');
const DEVICE_KEY = 'nfc.gate.key';
const QUEUE_KEY = 'nfc.gate.queue';
let info = { school_name: '', timezone: undefined, push_public_key: '' };
let cleanup = [];
let installPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'refresh' && location.hash.startsWith('#parent')) route();
  });
}

function field(label, input, hint) {
  return h('div', { class: 'field' }, h('label', null, label, input), hint ? h('div', { class: 'hint' }, hint) : null);
}

function header(title, ...actions) {
  return h('div', { class: 'app-head' }, h('a', { class: 'brand', href: '#' }, h('img', { src: '/icons/logo.svg', alt: '' }), h('span', null, title)), h('div', { class: 'row' }, actions));
}

function installButton() {
  if (!installPrompt) return null;
  return h('button', { class: 'btn btn-small', onclick: async () => { installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; route(); } }, 'Install app');
}

function route() {
  for (const fn of cleanup) fn();
  cleanup = [];
  const hash = location.hash.replace(/^#/, '');
  if (hash.startsWith('gate/pair/')) {
    store.set(DEVICE_KEY, decodeURIComponent(hash.slice('gate/pair/'.length)));
    history.replaceState(null, '', '#gate');
    return gate();
  }
  if (hash.startsWith('gate')) return gate();
  if (hash.startsWith('parent/child/')) return childHistory(Number(hash.split('/')[2]));
  if (hash.startsWith('parent')) return parent();
  if (api.token()) return parent();
  if (store.get(DEVICE_KEY)) return gate();
  return home();
}

function home() {
  clear(root, h('div', { class: 'app' },
    header(`${info.school_name} Attendance`, installButton()),
    h('div', { class: 'choice' },
      h('button', { class: 'card', onclick: () => (location.hash = '#parent') }, h('h2', null, "I'm a parent"), h('p', { class: 'muted' }, 'See when your child enters and leaves the campus and get a notification each time.')),
      h('button', { class: 'card', onclick: () => (location.hash = '#gate') }, h('h2', null, 'Gate reader'), h('p', { class: 'muted' }, 'Use this phone or tablet as the NFC reader at the campus gate.')),
      h('a', { class: 'card door', href: '/admin/' }, h('h2', null, 'School staff'), h('p', { class: 'muted' }, 'Open the school dashboard.')),
    ),
  ));
}

// ================= Parent =================

function parentSignIn() {
  let mode = 'activate';
  const box = h('div');
  function draw() {
    const activate = mode === 'activate';
    const form = h('form', { class: 'card' },
      h('h2', null, activate ? 'Activate with your code' : 'Sign in'),
      activate ? h('p', { class: 'small muted' }, 'The school texted you a code. Enter the mobile number that received it.') : null,
      field('Mobile number', h('input', { name: activate ? 'phone' : 'username', type: 'tel', autocomplete: 'tel', required: true, placeholder: '0917 123 4567' })),
      activate ? field('Code', h('input', { name: 'code', required: true, autocomplete: 'one-time-code', class: 'mono', placeholder: 'ABCD2345' })) : null,
      field(activate ? 'Choose a password' : 'Password', h('input', { name: 'password', type: 'password', required: true, minlength: activate ? 8 : null, autocomplete: activate ? 'new-password' : 'current-password' }), activate ? 'At least 8 characters. You will use it to sign in next time.' : null),
      h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, activate ? 'Activate' : 'Sign in'),
      h('p', { class: 'small' }, ' '),
      h('button', { type: 'button', class: 'btn btn-block', onclick: () => { mode = activate ? 'login' : 'activate'; draw(); } }, activate ? 'I already activated — sign in' : 'I have a new code from the school'),
      !activate ? h('p', { class: 'small muted' }, 'Forgot your password? Ask the school to text you a new code, then activate again.') : null,
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      try {
        const r = await api.post(activate ? '/api/parent/activate' : '/api/auth/login', data);
        if (r.user.role !== 'parent') {
          toast('This is a staff account. Opening the school dashboard.');
          location.href = '/admin/';
          return;
        }
        api.setToken(r.token);
        toast(activate ? 'Activated. Welcome!' : 'Signed in.', 'ok');
        route();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    clear(box, form);
  }
  draw();
  clear(root, h('div', { class: 'app' }, header(`${info.school_name} Attendance`, h('a', { class: 'btn btn-small', href: '#' }, 'Back')), box));
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function currentSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function notificationCard() {
  const card = h('div', { class: 'card' });
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  async function draw() {
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      clear(card, h('h2', null, 'Phone notifications'),
        h('p', { class: 'muted' }, isIos && !standalone
          ? 'On iPhone, tap Share then "Add to Home Screen", open the app from your home screen and sign in again to turn on notifications.'
          : 'This browser cannot show notifications. You will still get text messages.'));
      return;
    }
    const sub = await currentSubscription();
    const on = Notification.permission === 'granted' && sub;
    clear(card,
      h('h2', null, 'Phone notifications'),
      Notification.permission === 'denied'
        ? h('p', { class: 'muted' }, 'Notifications are blocked. Allow them for this site in your phone settings.')
        : h('p', { class: 'muted' }, on ? 'On. You get a notification each time your child taps in or out.' : 'Get a notification on this phone each time your child taps in or out.'),
      Notification.permission === 'denied' ? null : h('div', { class: 'row' },
        on
          ? [h('button', { class: 'btn', onclick: test }, 'Send a test'), h('button', { class: 'btn', onclick: off }, 'Turn off')]
          : h('button', { class: 'btn btn-primary', onclick: turnOn }, 'Turn on notifications'),
      ),
    );
  }
  async function turnOn() {
    try {
      if ((await Notification.requestPermission()) !== 'granted') return draw();
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ||
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(info.push_public_key) }));
      await api.post('/api/push/subscribe', { subscription: sub.toJSON() });
      toast('Notifications are on.', 'ok');
    } catch (err) {
      toast(`Could not turn on notifications: ${err.message}`, 'error');
    }
    draw();
  }
  async function off() {
    const sub = await currentSubscription();
    if (sub) {
      await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    }
    draw();
  }
  async function test() {
    try {
      const r = await api.post('/api/push/test');
      toast(r.ok ? 'Test sent. It should appear in a few seconds.' : `Failed: ${r.error}`, r.ok ? 'ok' : 'error');
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  await draw();
  return card;
}

function stateBlock(today) {
  const label = {
    not_arrived: ['Not yet arrived today', ''],
    on_campus: [`On campus since ${fmt.time(today.first_in || today.last?.at)}`, 'on_campus'],
    left: [`Left the campus at ${fmt.time(today.last?.at)}`, 'left'],
  }[today.state];
  return h('div', { class: `state ${label[1]}` }, h('span', { class: 'dot' }), h('div', null, h('b', null, label[0]), today.late ? h('div', { class: 'small' }, 'Arrived late') : null));
}

async function parent() {
  if (!api.token()) return parentSignIn();
  clear(root, h('div', { class: 'app' }, h('p', { class: 'muted' }, 'Loading…')));
  let data;
  try {
    data = await api.get('/api/parent/children');
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      api.setToken(null);
      return parentSignIn();
    }
    clear(root, h('div', { class: 'app' }, header(info.school_name), h('div', { class: 'card' }, h('p', null, 'You are offline or the server cannot be reached.'), h('button', { class: 'btn', onclick: route }, 'Try again'))));
    return;
  }
  const list = data.children.length
    ? data.children.map((c) => h('div', { class: 'card child' },
        h('div', { class: 'row spread' }, h('div', null, h('h2', null, c.name), h('div', { class: 'small muted' }, [c.grade, c.section].filter(Boolean).join(' · '))), c.has_card ? null : h('span', { class: 'badge badge-bad' }, 'No card yet')),
        stateBlock(c.today),
        c.today.logs.length ? h('div', { class: 'small muted' }, 'Today: ', c.today.logs.map((l) => `${l.direction} ${fmt.time(l.at)}`).join(' · ')) : null,
        h('a', { class: 'btn', href: `#parent/child/${c.id}` }, 'Attendance history'),
      ))
    : [h('div', { class: 'card' }, h('p', null, 'No students are linked to your number yet. Ask the school to add your mobile number to your child\'s record.'))];

  const signOut = h('button', { class: 'btn btn-small', onclick: async () => {
    const sub = await currentSubscription().catch(() => null);
    if (sub) await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    api.setToken(null);
    location.hash = '';
    route();
  } }, 'Sign out');

  clear(root, h('div', { class: 'app stack' },
    header(info.school_name, installButton(), signOut),
    h('p', { class: 'muted' }, fmt.date(new Date().toISOString())),
    list,
    await notificationCard(),
  ));

  cleanup.push(liveEvents(api, {
    attendance: (log) => {
      toast(`${log.first_name} ${log.direction === 'IN' ? 'entered' : 'left'} the campus at ${fmt.time(log.at)}`, 'ok');
      route();
    },
  }));
  const refresh = () => document.visibilityState === 'visible' && location.hash.startsWith('#parent') && !location.hash.includes('child') && route();
  document.addEventListener('visibilitychange', refresh);
  cleanup.push(() => document.removeEventListener('visibilitychange', refresh));
}

async function childHistory(id) {
  if (!api.token()) return parentSignIn();
  const [{ children }, { logs }] = await Promise.all([api.get('/api/parent/children'), api.get(`/api/parent/children/${id}/logs?days=60`)]);
  const child = children.find((c) => c.id === id);
  const days = new Map();
  for (const l of logs) {
    if (!days.has(l.local_date)) days.set(l.local_date, []);
    days.get(l.local_date).push(l);
  }
  clear(root, h('div', { class: 'app' },
    header(child ? child.first_name : 'History', h('a', { class: 'btn btn-small', href: '#parent' }, 'Back')),
    h('h1', null, 'Last 60 days'),
    days.size
      ? [...days].map(([day, items]) => h('div', { class: 'day' },
          h('h3', null, fmt.date(day)),
          h('div', { class: 'card' }, h('ul', { class: 'feed' }, items.slice().reverse().map((l) => h('li', null,
            h('div', { class: 'dir' }, h('span', { class: `badge badge-${l.direction === 'IN' ? 'in' : 'out'}` }, l.direction)),
            h('div', { class: 'who' }, h('b', null, l.direction === 'IN' ? 'Entered' : 'Left'), h('span', { class: 'small muted' }, l.device_name || (l.method === 'manual' ? 'Recorded by the school' : ''))),
            h('div', { class: 'when' }, h('b', null, fmt.time(l.at))),
          )))),
        ))
      : h('div', { class: 'card' }, h('p', { class: 'muted' }, 'No taps recorded yet.')),
  ));
}

// ================= Gate reader =================

function gatePair(message) {
  const form = h('form', { class: 'card' },
    h('h2', null, 'Pair this gate reader'),
    h('p', { class: 'muted' }, 'In the school dashboard go to Gate readers → Add reader, then open the pairing link on this device or paste the reader key here.'),
    message ? h('p', { class: 'badge badge-bad' }, message) : null,
    field('Reader key', h('input', { name: 'key', required: true, autocomplete: 'off', class: 'mono', placeholder: 'dev_…' })),
    h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Pair'),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    store.set(DEVICE_KEY, new FormData(form).get('key').trim());
    gate();
  });
  clear(root, h('div', { class: 'app' }, header('Gate reader', h('a', { class: 'btn btn-small', href: '#' }, 'Back')), form));
}

function loadQueue() {
  try {
    return JSON.parse(store.get(QUEUE_KEY) || '[]');
  } catch {
    return [];
  }
}
function saveQueue(q) {
  store.set(QUEUE_KEY, JSON.stringify(q.slice(-2000)));
}

let audio;
function beep(kind) {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const notes = { in: [880, 1320], out: [1320, 880], bad: [220, 180], dup: [660] }[kind] || [880];
    notes.forEach((freq, i) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.frequency.value = freq;
      o.type = kind === 'bad' ? 'square' : 'sine';
      g.gain.setValueAtTime(0.0001, audio.currentTime + i * 0.14);
      g.gain.exponentialRampToValueAtTime(0.3, audio.currentTime + i * 0.14 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + i * 0.14 + 0.13);
      o.connect(g).connect(audio.destination);
      o.start(audio.currentTime + i * 0.14);
      o.stop(audio.currentTime + i * 0.14 + 0.15);
    });
  } catch {}
  if (navigator.vibrate) navigator.vibrate(kind === 'bad' ? [80, 60, 80] : 60);
}

async function gate() {
  const key = store.get(DEVICE_KEY);
  if (!key) return gatePair();

  let me;
  try {
    me = await api.get('/api/device/me', { deviceKey: key });
    store.set('nfc.gate.me', JSON.stringify(me));
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      store.set(DEVICE_KEY, null);
      return gatePair(err.message);
    }
    try {
      me = JSON.parse(store.get('nfc.gate.me') || 'null');
    } catch {}
    if (!me) return gatePair('Cannot reach the server. Connect to the internet and try again.');
  }
  fmt.tz = me.timezone || fmt.tz;

  const clock = h('div', { class: 'kiosk-clock' });
  const prompt = h('div', { class: 'kiosk-prompt' }, 'Tap your ID card');
  const idle = h('div', null, clock, h('div', { class: 'wave' }, h('img', { src: '/icons/logo.svg', alt: '' })), prompt);
  const resultBox = h('div');
  const body = h('div', { class: 'kiosk-body' }, idle);
  const nfcPill = h('span', { class: 'pill' });
  const netPill = h('span', { class: 'pill' });
  const queuePill = h('span', { class: 'pill' });
  const startBtn = h('button', { class: 'btn btn-small' }, 'Start NFC');
  const typed = h('input', { class: 'mono', placeholder: 'Card ID', autocomplete: 'off' });
  const manualForm = h('form', { class: 'row', hidden: true }, typed, h('button', { class: 'btn btn-small', type: 'submit' }, 'Send'));
  const menuBtn = h('button', { class: 'btn btn-small' }, 'Menu');
  const modeText = { auto: 'IN / OUT', in: 'Entrance — IN', out: 'Exit — OUT' }[me.device.mode];
  const kiosk = h('div', { class: 'kiosk' },
    h('div', { class: 'kiosk-top' }, h('div', { class: 'row' }, h('b', null, me.school_name), h('span', null, `${me.device.name} · ${modeText}`)), h('div', { class: 'row' }, startBtn, menuBtn)),
    body,
    h('div', { class: 'kiosk-foot' }, h('div', { class: 'row' }, nfcPill, netPill, queuePill), manualForm),
  );
  clear(root, kiosk);

  const tick = () => (clock.textContent = new Intl.DateTimeFormat('en-US', { timeZone: fmt.tz, hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date()));
  tick();
  const clockTimer = setInterval(tick, 1000);
  cleanup.push(() => clearInterval(clockTimer));

  let wakeLock = null;
  const lock = async () => { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {} };
  lock();
  const onVisible = () => document.visibilityState === 'visible' && lock();
  document.addEventListener('visibilitychange', onVisible);
  cleanup.push(() => { document.removeEventListener('visibilitychange', onVisible); wakeLock?.release?.().catch(() => {}); });

  function updatePills() {
    const q = loadQueue().length;
    netPill.textContent = navigator.onLine ? 'Online' : 'Offline';
    netPill.className = `pill${navigator.onLine ? '' : ' off'}`;
    queuePill.textContent = `${q} waiting to sync`;
    queuePill.hidden = q === 0;
  }
  updatePills();

  let resetTimer;
  function show(kind, lines) {
    kiosk.className = `kiosk k-${kind}`;
    clear(resultBox, lines);
    clear(body, resultBox);
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      kiosk.className = 'kiosk';
      clear(body, idle);
    }, kind === 'bad' ? 5000 : 3500);
  }

  async function send(uid, at) {
    return api.post('/api/tap', at ? { uid, at } : { uid }, { deviceKey: key });
  }

  let lastUid = '';
  let lastAt = 0;
  async function handle(raw) {
    const uid = normalizeUid(raw);
    if (uid.length < 4) return;
    const now = Date.now();
    if (uid === lastUid && now - lastAt < 3000) return;
    lastUid = uid;
    lastAt = now;
    try {
      const r = await send(uid);
      if (r.status === 'ok') {
        beep(r.direction === 'IN' ? 'in' : 'out');
        show(r.direction === 'IN' ? 'in' : 'out', [
          h('div', { class: 'kiosk-dir' }, r.direction === 'IN' ? 'IN' : 'OUT'),
          h('div', { class: 'kiosk-name' }, r.student.name),
          h('div', { class: 'kiosk-prompt' }, [r.student.grade, r.student.section].filter(Boolean).join(' · ')),
          h('div', { class: 'kiosk-prompt' }, `${r.message} · ${r.time}`),
        ]);
      } else if (r.status === 'duplicate') {
        beep('dup');
        show('dup', [h('div', { class: 'kiosk-name' }, r.student.name), h('div', { class: 'kiosk-prompt' }, r.message)]);
      } else {
        beep('bad');
        show('bad', [h('div', { class: 'kiosk-name' }, r.status === 'unknown' ? 'Card not registered' : 'Card turned off'), h('div', { class: 'kiosk-prompt' }, r.message), h('div', { class: 'mono' }, r.uid || '')]);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        beep('bad');
        if (err.status === 401) {
          store.set(DEVICE_KEY, null);
          return gatePair(err.message);
        }
        show('bad', [h('div', { class: 'kiosk-name' }, 'Not recorded'), h('div', { class: 'kiosk-prompt' }, err.message)]);
        return;
      }
      // No connection: keep the tap with its time and send it later.
      const q = loadQueue();
      q.push({ uid, at: new Date().toISOString() });
      saveQueue(q);
      updatePills();
      beep('in');
      show('dup', [h('div', { class: 'kiosk-name' }, 'Tap saved'), h('div', { class: 'kiosk-prompt' }, 'Offline — it will be sent when the internet is back.')]);
    }
  }

  let syncing = false;
  async function sync() {
    if (syncing || !navigator.onLine) return;
    syncing = true;
    try {
      let q = loadQueue();
      while (q.length) {
        try {
          await send(q[0].uid, q[0].at);
        } catch (err) {
          if (!(err instanceof ApiError)) break; // still offline
          if (err.status === 401) break;
          // The server rejected this tap for good (e.g. too old): drop it.
        }
        q = loadQueue().slice(1);
        saveQueue(q);
      }
    } finally {
      syncing = false;
      updatePills();
    }
  }
  const syncTimer = setInterval(sync, 15000);
  const onOnline = () => { updatePills(); sync(); };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', updatePills);
  cleanup.push(() => { clearInterval(syncTimer); window.removeEventListener('online', onOnline); window.removeEventListener('offline', updatePills); });
  sync();

  // Phone NFC (Chrome on Android).
  let nfcAbort = null;
  async function startNfc() {
    if (!hasWebNfc()) return;
    try {
      nfcAbort = new AbortController();
      const reader = new window.NDEFReader();
      await reader.scan({ signal: nfcAbort.signal });
      reader.addEventListener('reading', (e) => handle(e.serialNumber));
      reader.addEventListener('readingerror', () => { beep('bad'); show('bad', [h('div', { class: 'kiosk-name' }, 'Try again'), h('div', { class: 'kiosk-prompt' }, 'Hold the card still on the back of the device.')]); });
      nfcPill.textContent = 'NFC on';
      nfcPill.className = 'pill';
      startBtn.hidden = true;
    } catch (err) {
      nfcPill.textContent = 'NFC off';
      nfcPill.className = 'pill off';
      startBtn.hidden = false;
      if (err.name !== 'AbortError') toast(`NFC: ${err.message}`, 'error');
    }
  }
  cleanup.push(() => nfcAbort?.abort());
  startBtn.addEventListener('click', () => { beep('dup'); startNfc(); });
  if (hasWebNfc()) {
    nfcPill.textContent = 'NFC off';
    nfcPill.className = 'pill off';
    try {
      const perm = await navigator.permissions.query({ name: 'nfc' });
      if (perm.state === 'granted') startNfc();
    } catch {}
  } else {
    startBtn.hidden = true;
    nfcPill.textContent = 'USB reader / keyboard';
  }

  // USB readers that type the card number and press Enter.
  let buffer = '';
  let bufferAt = 0;
  const onKey = (e) => {
    if (e.target === typed) return;
    const now = Date.now();
    if (now - bufferAt > 120) buffer = '';
    bufferAt = now;
    if (e.key === 'Enter') {
      if (buffer.length >= 4) handle(buffer);
      buffer = '';
    } else if (e.key.length === 1) {
      buffer += e.key;
    }
  };
  document.addEventListener('keydown', onKey);
  cleanup.push(() => document.removeEventListener('keydown', onKey));

  manualForm.addEventListener('submit', (e) => {
    e.preventDefault();
    handle(typed.value);
    typed.value = '';
  });

  menuBtn.addEventListener('click', () => {
    const dlg = h('dialog', null,
      h('h2', null, 'Gate reader'),
      h('p', null, `${me.device.name} · ${modeText}`),
      h('p', { class: 'small muted' }, 'Change the mode or name in the school dashboard under Gate readers.'),
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn', onclick: () => { manualForm.hidden = !manualForm.hidden; dlg.close(); if (!manualForm.hidden) typed.focus(); } }, 'Type a card ID'),
        h('button', { class: 'btn', onclick: () => { dlg.close(); route(); } }, 'Reload'),
        h('button', { class: 'btn btn-danger', onclick: () => { if (confirm('Unpair this reader? You will need a new pairing link.')) { store.set(DEVICE_KEY, null); dlg.close(); location.hash = ''; route(); } } }, 'Unpair'),
        h('button', { class: 'btn btn-primary', onclick: () => dlg.close() }, 'Close'),
      ),
    );
    document.body.append(dlg);
    dlg.addEventListener('close', () => dlg.remove());
    dlg.showModal();
  });
}

async function start() {
  try {
    info = await fetch('/api/public/info').then((r) => r.json());
    store.set('nfc.info', JSON.stringify(info));
  } catch {
    try {
      info = JSON.parse(store.get('nfc.info') || 'null') || info;
    } catch {}
  }
  fmt.tz = info.timezone;
  document.title = `${info.school_name} Attendance`;
  window.addEventListener('hashchange', route);
  route();
}

start();
