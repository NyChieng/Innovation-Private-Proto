import { msg, t } from './i18n.js';

// Error messages the API sends that a person is likely to see. They are
// translated when they arrive; one not listed here is shown in English.
[
  msg('Not found'), msg('Sign in required'), msg('Not permitted'),
  msg('No such species.'), msg('Unknown tag'),
  msg('This plant is no longer on display.'),
  msg('This account has been deactivated by an administrator.'),
  msg('No account with that email address.'),
  msg('Incorrect password.'),
  msg('This account is locked after too many wrong passwords.'),
  msg('That scientific name is already in the species list.'),
  msg('Scientific name is required.'),
  msg('That does not look like an email address.'),
  msg('An account with that email address already exists.'),
  msg('Full name is required.'), msg('Email address is required.'), msg('Choose a role.'),
  msg('Not permitted to change roles.'),
  msg('Please describe what looks wrong.'),
  msg('A location or site name is required.'),
  msg('Choose a species, or type a name under "species not listed".'),
  msg('This record has no confirmed species. Set the species first, then approve it.'),
  msg('You cannot review a record you submitted yourself. Another reviewer must check it.'),
  msg('A note is required when returning a record, so the botanist knows what to change.'),
  msg('Only the person who registered this record can resubmit it.'),
  msg('Only an archived record can be restored.'),
  msg('A published record must have a confirmed species.'),
  msg('No QR code has been issued for this record yet.'),
  msg('Your current password is not correct.'),
  msg('The new password must be at least 8 characters.'),
  msg('The new password is too long (maximum 128 characters).'),
  msg('Choose a password you have not used here before.'),
  msg('The new password needs at least one letter and one number.'),
  msg('That email address and recovery code do not match.'),
  msg('This request has not been approved, or it has run out. Ask again.'),
  msg('A recovery email is for administrators.'),
  msg('Sign-in timed out. Enter your password again.'),
  msg('Start the setup again - scan a new QR code.'),
  msg('That code is not right. Check the app shows FloraScan and try the current code.'),
  msg('Use a different address from the one you sign in with.'),
  msg('A code was sent a moment ago. Wait a minute before asking again.'),
  msg('That code is not right.'),
  msg('No code is waiting, or it ran out. Send a new one.'),
  msg('That email address and code do not match.'),
  msg('There is no reset request waiting for this account.'),
  msg('That is not the code on their screen.'),
  msg('Too many wrong codes, so the request has been refused. They can ask again.'),
  msg('Face ID and fingerprint sign-in need the named address, not a number.'),
  msg('Face ID or fingerprint sign-in could not be confirmed. Try again, or use your password.'),
  msg('This device has no FloraScan passkey any more. Sign in with your password.'),
  msg('Too many failed sign-ins from this network. Try again later, or ask an administrator.'),
  msg('Too many failed sign-ins from this device. Try again later, or ask an administrator.'),
  msg('Enter a whole number from 3 to 20.'),
  msg('Enter a whole number from 1 to 1440.'),
  msg('Only an administrator can open the audit trail.'),
  msg('This record has been changed again since. Restoring would undo those later changes too.'),
  msg('This record no longer exists.'),
  msg('The earlier species no longer exists.'),
  msg('The earlier role no longer exists.'),
  msg('You cannot change your own role or deactivate yourself.'),
  msg('A record being added is not undone here. Archive or deactivate it instead.'),
  msg('A review decision is not undone here. Archive the plant or edit it instead.'),
  msg('A review decision is not undone here.'),
  msg('Security events - passwords, two-step verification, Face ID / fingerprint, locks - cannot be restored.'),
  msg('This kind of entry cannot be restored.'),
  msg('This entry has no earlier values to put back.'),
];

const TOKEN_KEY = 'florascan.token';

export const getToken = () => localStorage.getItem(TOKEN_KEY) || null;
export const setToken = (token) => (token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY));

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/*
 * A random id for this browser, so an administrator can choose to lock a
 * device after too many wrong passwords (Server/lockout.js). It identifies
 * nothing about the person - it is made up here and kept only in this browser.
 */
const DEVICE_KEY = 'florascan.device-id';
let deviceId = null;
function getDeviceId() {
  if (deviceId) return deviceId;
  try { deviceId = localStorage.getItem(DEVICE_KEY); } catch { /* private mode */ }
  if (!/^[a-f0-9]{32}$/.test(deviceId || '')) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    deviceId = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem(DEVICE_KEY, deviceId); } catch { /* kept for this visit only */ }
  }
  return deviceId;
}

async function request(method, path, body) {
  const headers = { 'X-Device-Id': getDeviceId() };
  const token = getToken();
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(t('Cannot reach the server. Is it still running?'), 0, null);
  }

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }

  if (!res.ok) {
    // A revoked or expired session should not leave a stale token behind.
    if (res.status === 401 && token) setToken(null);
    // Server messages are English; the common ones have a translation, and
    // anything else is shown as the server wrote it.
    throw new ApiError(data?.error ? t(data.error) : t('Request failed ({status})', { status: res.status }), res.status, data);
  }
  return data;
}

/**
 * A protected image (an AI camera snapshot) as an object URL. An <img src>
 * cannot send the Authorization header, so it is fetched here instead. The
 * caller revokes the URL when it is done with it.
 */
export async function protectedImageUrl(path) {
  const token = getToken();
  const res = await fetch(path.startsWith('/api/') ? path : '/api' + path, {
    headers: token ? { Authorization: 'Bearer ' + token } : {},
  });
  if (!res.ok) throw new ApiError(t('Request failed ({status})', { status: res.status }), res.status, null);
  return URL.createObjectURL(await res.blob());
}

const qs = (params) => {
  const sp = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') sp.set(k, v);
  });
  const s = sp.toString();
  return s ? '?' + s : '';
};

export const api = {
  get: (p, params) => request('GET', p + qs(params)),
  post: (p, body) => request('POST', p, body ?? {}),
  patch: (p, body) => request('PATCH', p, body ?? {}),

  bootstrap: () => request('GET', '/bootstrap'),
  me: () => request('GET', '/auth/me'),
  login: (email, password) => request('POST', '/auth/login', { email, password }),
  login2fa: (ticket, code) => request('POST', '/auth/login/2fa', { ticket, code }),
  twoFactorSetup: (current_password) => request('POST', '/auth/2fa/setup', { current_password }),
  twoFactorEnable: (code) => request('POST', '/auth/2fa/enable', { code }),
  twoFactorDisable: (current_password, code) => request('POST', '/auth/2fa/disable', { current_password, code }),
  logout: () => request('POST', '/auth/logout', {}),
  changePassword: (current_password, new_password) => request('POST', '/auth/password', { current_password, new_password }),
  newRecoveryCode: (current_password) => request('POST', '/auth/recovery-code', { current_password }),
  recover: (email, recovery_code, new_password) => request('POST', '/auth/recover', { email, recovery_code, new_password }),
  recoveryEmailStart: (email, current_password) => request('POST', '/auth/recovery-email', { email, current_password }),
  recoveryEmailConfirm: (code) => request('POST', '/auth/recovery-email/confirm', { code }),
  emailReset: (email) => request('POST', '/auth/email-reset', { email }),
  emailResetComplete: (email, code, new_password) => request('POST', '/auth/email-reset/complete', { email, code, new_password }),
  resetRequest: (email) => request('POST', '/auth/reset-request', { email }),
  resetRequestStatus: (token) => request('POST', '/auth/reset-request/status', { token }),
  resetRequestComplete: (token, new_password) => request('POST', '/auth/reset-request/complete', { token, new_password }),
  approveReset: (id, code) => request('POST', `/users/${id}/reset-request/approve`, { code }),
  denyReset: (id) => request('POST', `/users/${id}/reset-request/deny`, {}),

  passkeys: () => request('GET', '/auth/passkeys'),
  passkeyRegisterOptions: () => request('POST', '/auth/passkeys/register/options', {}),
  passkeyRegister: (response) => request('POST', '/auth/passkeys/register/verify', { response }),
  passkeyRemove: (id) => request('DELETE', '/auth/passkeys/' + id),
  passkeyLoginOptions: () => request('POST', '/auth/passkeys/login/options', {}),
  passkeyLogin: (flow, response) => request('POST', '/auth/passkeys/login/verify', { flow, response }),

  publicPlants: (params) => request('GET', '/public/plants' + qs(params)),
  publicStats: () => request('GET', '/public/stats'),
  plantByToken: (token) => request('GET', '/public/plants/token/' + encodeURIComponent(token)),
  plantById: (id) => request('GET', '/public/plants/' + id),

  species: (params) => request('GET', '/species' + qs(params)),
  speciesById: (id) => request('GET', '/species/' + id),

  plants: (params) => request('GET', '/plants' + qs(params)),
  counts: () => request('GET', '/plants/counts'),
  createPlant: (body) => request('POST', '/plants', body),
  updatePlant: (id, body) => request('PATCH', '/plants/' + id, body),
  approve: (id, note) => request('POST', `/plants/${id}/approve`, { note }),
  reject: (id, note) => request('POST', `/plants/${id}/reject`, { note }),
  archive: (id, reason) => request('POST', `/plants/${id}/archive`, { reason }),
  restore: (id) => request('POST', `/plants/${id}/restore`, {}),
  resubmit: (id, note) => request('POST', `/plants/${id}/resubmit`, { note }),
  history: (id) => request('GET', `/plants/${id}/history`),

  submissions: (params) => request('GET', '/submissions' + qs(params)),
  qr: (plantId) => request('GET', `/qr/${plantId}`),

  notifications: () => request('GET', '/notifications'),
  readNotification: (id) => request('POST', `/notifications/${id}/read`, {}),
  readAllNotifications: () => request('POST', '/notifications/read-all', {}),

  reports: () => request('GET', '/reports'),
  createReport: (body) => request('POST', '/reports', body),
  resolveReport: (id, body) => request('POST', `/reports/${id}/resolve`, body),

  users: () => request('GET', '/users'),
  createUser: (body) => request('POST', '/users', body),
  updateUser: (id, body) => request('PATCH', '/users/' + id, body),
  resetPassword: (id) => request('POST', `/users/${id}/reset-password`, {}),
  unlockUser: (id) => request('POST', `/users/${id}/unlock`, {}),

  activity: () => request('GET', '/activity'),
  audit: (params) => request('GET', '/audit' + qs(params)),
  restoreAudit: (id, force = false) => request('POST', `/audit/${id}/restore`, { force }),
  adminStats: () => request('GET', '/admin/stats'),

  settings: () => request('GET', '/settings'),
  updateSetting: (key, value) => request('PATCH', '/settings/' + key, { value }),
  lockouts: () => request('GET', '/security/lockouts'),
  liftLockout: (id) => request('DELETE', '/security/lockouts/' + id),

  sensors: () => request('GET', '/sensors'),
  connect: () => request('GET', '/connect'),
};
