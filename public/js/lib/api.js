// Fetch wrapper for the JSON API. Adds the CSRF header, parses errors into ApiError.
export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

const listeners = new Set();
/** Subscribe to 401 responses (session expired / banned). */
export function onUnauthorized(fn) { listeners.add(fn); return () => listeners.delete(fn); }

async function request(method, path, body) {
  const opts = { method, headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch('/api' + path, opts);
  } catch {
    throw new ApiError(0, 'Network error — check your connection and try again.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    if (res.status === 401) listeners.forEach((fn) => fn());
    throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`, data);
  }
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b ?? {}),
  patch: (p, b) => request('PATCH', p, b ?? {}),
  del: (p, b) => request('DELETE', p, b),
  /** Multipart upload with progress callback (0..1). Returns { promise, abort }. */
  upload(path, form, onProgress) {
    const xhr = new XMLHttpRequest();
    const promise = new Promise((resolve, reject) => {
      xhr.open('POST', '/api' + path);
      xhr.setRequestHeader('X-Requested-With', 'fetch');
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new ApiError(xhr.status, (data && data.error) || `Upload failed (${xhr.status})`, data));
      };
      xhr.onerror = () => reject(new ApiError(0, 'Network error during upload'));
      xhr.onabort = () => reject(new ApiError(0, 'Upload cancelled'));
      xhr.send(form);
    });
    return { promise, abort: () => xhr.abort() };
  },
};
