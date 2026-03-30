const {
  json,
  methodNotAllowed,
  requireSession,
} = require('./_dashboard');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed('GET');

  const { error, session } = requireSession(event);
  if (error) return error;

  return json(200, { ok: true, ...session });
};
