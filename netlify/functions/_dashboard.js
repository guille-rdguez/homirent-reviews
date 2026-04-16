const crypto = require('crypto');

const DEFAULT_AUTH_USER = 'admin';
const DEFAULT_AUTH_HASH =
  'a1c9242db87c2a5eddcbe2d90454822297a7c5e84cea7f7a2d3dbc82ffefa21c';
const DEFAULT_SESSION_HOURS = 12;

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

function methodNotAllowed(allow) {
  return json(405, { ok: false, error: 'Metodo no permitido' }, { Allow: allow });
}

function unauthorized(message = 'No autorizado') {
  return json(401, { ok: false, error: message });
}

function serverError(message, statusCode = 500) {
  return json(statusCode, { ok: false, error: message });
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseSessionHours(value) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_SESSION_HOURS;
  return hours;
}

function getAuthConfig() {
  const username = process.env.DASHBOARD_USERNAME || DEFAULT_AUTH_USER;
  const explicitHash = process.env.DASHBOARD_PASSWORD_HASH;
  const plainPassword = process.env.DASHBOARD_PASSWORD;
  const passwordHash =
    explicitHash ||
    (plainPassword ? sha256Hex(`${username}::${plainPassword}`) : DEFAULT_AUTH_HASH);
  const sessionSecret = process.env.DASHBOARD_SESSION_SECRET || passwordHash;
  const sessionHours = parseSessionHours(process.env.DASHBOARD_SESSION_HOURS);

  return {
    username,
    passwordHash,
    sessionSecret,
    sessionTtlSeconds: Math.round(sessionHours * 3600),
  };
}

function createSession(username) {
  const config = getAuthConfig();
  const exp = Math.floor(Date.now() / 1000) + config.sessionTtlSeconds;
  const payload = Buffer.from(JSON.stringify({ u: username, exp })).toString(
    'base64url'
  );
  const signature = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(payload)
    .digest('hex');

  return {
    username,
    sessionToken: `${payload}.${signature}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') {
    throw new Error('Sesion requerida');
  }

  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('Sesion invalida');
  }

  const [payload, signature] = parts;
  const config = getAuthConfig();
  const expectedSignature = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(payload)
    .digest('hex');

  if (!timingSafeEqual(signature, expectedSignature)) {
    throw new Error('Sesion invalida');
  }

  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch (error) {
    throw new Error('Sesion invalida');
  }

  if (decoded.u !== config.username || !Number.isFinite(decoded.exp)) {
    throw new Error('Sesion invalida');
  }

  if (decoded.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error('Sesion expirada');
  }

  return {
    username: decoded.u,
    expiresAt: new Date(decoded.exp * 1000).toISOString(),
  };
}

function validateCredentials(username, password) {
  const config = getAuthConfig();
  const digest = sha256Hex(`${username}::${password}`);
  return username === config.username && timingSafeEqual(digest, config.passwordHash);
}

function parseJsonBody(body) {
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch (error) {
    return null;
  }
}

function readBearerToken(headers = {}) {
  const value = headers.authorization || headers.Authorization || '';
  if (typeof value === 'string' && value.startsWith('Bearer ')) {
    return value.slice(7).trim();
  }
  return '';
}

function requireSession(event) {
  const token = readBearerToken(event.headers);
  if (!token) return { error: unauthorized('Sesion requerida') };
  try {
    return { session: verifySessionToken(token) };
  } catch (error) {
    return { error: unauthorized(error.message || 'Sesion invalida') };
  }
}

async function readErrorText(response) {
  try {
    return (await response.text()).trim();
  } catch (error) {
    return '';
  }
}

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_DASHBOARD_KEY;

  if (!url || !key) {
    throw new Error(
      'Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en el entorno del dashboard'
    );
  }

  return { url, key };
}

function createSupabaseHeaders(extraHeaders = {}) {
  const { key } = getSupabaseConfig();
  const headers = {
    apikey: key,
    ...extraHeaders,
  };
  if (!String(key).startsWith('sb_')) {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

function normalizeWhitespace(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

async function fetchDashboardData() {
  const { url } = getSupabaseConfig();
  const headers = createSupabaseHeaders();

  const propertiesUrl =
    `${url}/rest/v1/properties?select=id,city,name&active=eq.true&order=city,name`;
  const reviewsUrl =
    `${url}/rest/v1/reviews?select=id,guest_name,room_name,rating,comment,would_return,source,channel,created_at,property_id,raw_payload,properties(name,city)&order=created_at.desc&limit=2000`;

  const [propertiesRes, reviewsRes] = await Promise.all([
    fetch(propertiesUrl, { headers }),
    fetch(reviewsUrl, { headers }),
  ]);

  if (!propertiesRes.ok) {
    const details = await readErrorText(propertiesRes);
    throw new Error(details || `Supabase devolvio ${propertiesRes.status} al leer properties`);
  }

  if (!reviewsRes.ok) {
    const details = await readErrorText(reviewsRes);
    throw new Error(details || `Supabase devolvio ${reviewsRes.status} al leer reviews`);
  }

  const [properties, reviews] = await Promise.all([
    propertiesRes.json(),
    reviewsRes.json(),
  ]);

  return { properties, reviews };
}

async function createProperty(input = {}) {
  const name = normalizeWhitespace(input.name);
  const city = normalizeWhitespace(input.city);
  if (!name || !city) {
    throw new Error('Nombre y ciudad son obligatorios');
  }

  const { url } = getSupabaseConfig();
  const response = await fetch(`${url}/rest/v1/properties`, {
    method: 'POST',
    headers: createSupabaseHeaders({
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    }),
    body: JSON.stringify({
      id: crypto.randomUUID(),
      name,
      city,
      active: true,
    }),
  });

  if (!response.ok) {
    const details = await readErrorText(response);
    throw new Error(details || `Supabase devolvio ${response.status} al crear complejo`);
  }

  let createdRows = [];
  try {
    createdRows = await response.json();
  } catch (error) {
    createdRows = [];
  }

  const property = Array.isArray(createdRows) ? createdRows[0] : createdRows;
  if (!property?.id) {
    throw new Error('Supabase no devolvio el complejo creado');
  }

  return property;
}

async function deleteReviewById(reviewId) {
  const normalizedId = String(reviewId || '').trim();
  if (!normalizedId) {
    throw new Error('Review invalida');
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(normalizedId)) {
    throw new Error('Review invalida');
  }

  const { url } = getSupabaseConfig();
  const deleteUrl =
    `${url}/rest/v1/reviews?id=eq.${encodeURIComponent(normalizedId)}`;
  const response = await fetch(deleteUrl, {
    method: 'DELETE',
    headers: createSupabaseHeaders({
      Prefer: 'return=representation',
    }),
  });

  if (!response.ok) {
    const details = await readErrorText(response);
    throw new Error(details || `Supabase devolvio ${response.status} al borrar review`);
  }

  let deletedRows = [];
  try {
    deletedRows = await response.json();
  } catch (error) {
    deletedRows = [];
  }

  return {
    deleted: deletedRows.length > 0,
  };
}

module.exports = {
  createProperty,
  createSession,
  createSupabaseHeaders,
  deleteReviewById,
  fetchDashboardData,
  getSupabaseConfig,
  json,
  methodNotAllowed,
  parseJsonBody,
  readErrorText,
  requireSession,
  serverError,
  unauthorized,
  validateCredentials,
};
