const { loadBookingDashboard } = require('./_booking_reviews');
const { json, methodNotAllowed, requireSession, serverError } = require('./_dashboard');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed('GET');

  const { error } = requireSession(event);
  if (error) return error;

  const params = new URLSearchParams(event.queryStringParameters || {});
  const propertyId = String(params.get('propertyId') || '').trim();
  const year = String(params.get('year') || '').trim();
  const month = String(params.get('month') || '').trim();

  if (!propertyId) return serverError('propertyId es obligatorio', 400);

  try {
    const result = await loadBookingDashboard({ propertyId, year, month });
    return json(200, { ok: true, ...result });
  } catch (err) {
    console.error(err);
    return serverError(err.message || 'No se pudo cargar el dashboard de Booking');
  }
};
