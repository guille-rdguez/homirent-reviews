const {
  createProperty,
  json,
  methodNotAllowed,
  parseJsonBody,
  requireSession,
  serverError,
} = require('./_dashboard');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed('POST');

  const { error } = requireSession(event);
  if (error) return error;

  const payload = parseJsonBody(event.body);
  if (!payload) return serverError('Body JSON invalido', 400);

  try {
    const property = await createProperty(payload);
    return json(200, { ok: true, property });
  } catch (error) {
    console.error(error);
    return serverError(error.message || 'No se pudo crear el complejo');
  }
};
