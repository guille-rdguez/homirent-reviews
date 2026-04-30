const { translateExistingBookingReviews } = require('./_booking_reviews');
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
  const year = String(payload.year || '').trim();
  const month = String(payload.month || '').trim();
  const force = Boolean(payload.force);

  if (!propertyId) return serverError('propertyId es obligatorio', 400);

  try {
    const result = await translateExistingBookingReviews({
      propertyId,
      year,
      month,
      force,
    });
    return json(200, { ok: true, ...result });
  } catch (err) {
    console.error(err);
    return serverError(err.message || 'No se pudo traducir Booking');
  }
};
