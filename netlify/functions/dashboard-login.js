const {
  createSession,
  json,
  methodNotAllowed,
  parseJsonBody,
  serverError,
  unauthorized,
  validateCredentials,
} = require('./_dashboard');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed('POST');

  const payload = parseJsonBody(event.body);
  if (!payload) return serverError('Body JSON invalido', 400);

  const username = String(payload.username || '').trim();
  const password = String(payload.password || '');

  if (!username || !password) {
    return serverError('Usuario y contraseña son obligatorios', 400);
  }

  if (!validateCredentials(username, password)) {
    return unauthorized('Usuario o contraseña incorrectos');
  }

  return json(200, { ok: true, ...createSession(username) });
};
