// Shared helpers for the website, the dashboard and the app.

export const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value === null || value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {}
  },
};

export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export function createApi(tokenKey) {
  const api = {
    onUnauthorized: null,
    token: () => store.get(tokenKey),
    setToken: (t) => store.set(tokenKey, t),
    async request(method, path, body, { deviceKey, raw } = {}) {
      const headers = {};
      const token = api.token();
      if (token && !deviceKey) headers.Authorization = `Bearer ${token}`;
      if (deviceKey) headers['X-Device-Key'] = deviceKey;
      let payload;
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      const res = await fetch(path, { method, headers, body: payload });
      if (raw && res.ok) return res;
      const type = res.headers.get('content-type') || '';
      const data = type.includes('json') ? await res.json() : await res.text();
      if (!res.ok) {
        if (res.status === 401 && token && !deviceKey) {
          api.setToken(null);
          if (api.onUnauthorized) api.onUnauthorized();
        }
        throw new ApiError(res.status, (data && data.error) || res.statusText || 'Request failed', data);
      }
      return data;
    },
    get: (p, o) => api.request('GET', p, undefined, o),
    post: (p, b, o) => api.request('POST', p, b ?? {}, o),
    put: (p, b, o) => api.request('PUT', p, b ?? {}, o),
    del: (p, o) => api.request('DELETE', p, undefined, o),
  };
  return api;
}

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  let value;
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'value') value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  if (value !== undefined) el.value = value;
  return el;
}

export function clear(el, ...children) {
  el.replaceChildren();
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

let toastBox;
export function toast(message, kind = 'info') {
  if (!toastBox) {
    toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastBox);
  }
  const t = h('div', { class: `toast toast-${kind}` }, message);
  toastBox.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3500);
}

export const fmt = {
  tz: undefined,
  time(iso) {
    return iso ? new Intl.DateTimeFormat('en-US', { timeZone: fmt.tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) : '';
  },
  date(isoOrDay) {
    if (!isoOrDay) return '';
    const d = /^\d{4}-\d{2}-\d{2}$/.test(isoOrDay) ? new Date(`${isoOrDay}T12:00:00Z`) : new Date(isoOrDay);
    const tz = /^\d{4}-\d{2}-\d{2}$/.test(isoOrDay) ? 'UTC' : fmt.tz;
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(d);
  },
  dateTime(iso) {
    return iso ? `${fmt.date(iso)}, ${fmt.time(iso)}` : '';
  },
  ago(iso) {
    if (!iso) return 'never';
    const s = Math.round((Date.now() - new Date(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return fmt.date(iso);
  },
  today() {
    const p = {};
    for (const x of new Intl.DateTimeFormat('en-US', { timeZone: fmt.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())) p[x.type] = x.value;
    return `${p.year}-${p.month}-${p.day}`;
  },
};

export function normalizeUid(raw) {
  return String(raw || '').toUpperCase().replace(/[^0-9A-F]/g, '');
}

export const hasWebNfc = () => 'NDEFReader' in window;

// Reads one NFC card with the phone (Chrome on Android). Resolves with the card UID.
export async function scanOnce(signal) {
  const reader = new window.NDEFReader();
  return new Promise((resolve, reject) => {
    reader.addEventListener('reading', (e) => resolve(normalizeUid(e.serialNumber)), { once: true });
    reader.addEventListener('readingerror', () => reject(new Error('Could not read the card. Hold it still and try again.')), { once: true });
    reader.scan({ signal }).catch(reject);
  });
}

// Live updates from the server (Server-Sent Events) with automatic reconnect.
export function liveEvents(api, handlers) {
  let source;
  let stopped = false;
  let timer;
  async function open() {
    if (stopped) return;
    try {
      const { ticket } = await api.post('/api/events/ticket');
      source = new EventSource(`/api/events?ticket=${encodeURIComponent(ticket)}`);
      for (const [type, fn] of Object.entries(handlers)) source.addEventListener(type, (e) => fn(JSON.parse(e.data)));
      source.onerror = () => {
        source.close();
        timer = setTimeout(open, 4000);
      };
    } catch {
      timer = setTimeout(open, 8000);
    }
  }
  open();
  return () => {
    stopped = true;
    clearTimeout(timer);
    if (source) source.close();
  };
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
