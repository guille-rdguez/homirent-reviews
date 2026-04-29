const { buildPreview } = require('./_booking_reviews');
const {
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

  const propertyId = String(payload.propertyId || '').trim();
  const filename = String(payload.filename || '').trim();
  const csvBase64 = String(payload.csvBase64 || '').trim();

  if (!propertyId) return serverError('propertyId es obligatorio', 400);
  if (!csvBase64) return serverError('csvBase64 es obligatorio', 400);

  try {
    const result = await buildPreview({ propertyId, filename, csvBase64 });
    return json(200, { ok: true, ...result });
  } catch (err) {
    console.error(err);
    return serverError(err.message || 'No se pudo analizar el CSV de Booking');
  }
};
