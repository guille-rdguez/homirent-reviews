const {
  json,
  methodNotAllowed,
} = require('./_dashboard');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed('POST');
  // Sesiones son stateless (JWT-like HMAC); el cliente descarta el token al hacer logout
  return json(200, { ok: true });
};
