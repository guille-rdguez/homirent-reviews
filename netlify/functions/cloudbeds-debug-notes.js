const { cloudbedsGet, json } = require('./_cloudbeds');
const { requireSession, serverError, methodNotAllowed } = require('./_dashboard');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed('GET');
  const { error } = requireSession(event);
  if (error) return error;

  const { reservationID, propertyID } = event.queryStringParameters || {};
  if (!reservationID || !propertyID) return serverError('reservationID y propertyID requeridos', 400);

  try {
    const result = await cloudbedsGet('getReservationNotes', { reservationID, propertyID });
    return json(200, { ok: true, result });
  } catch (err) {
    return json(200, { ok: false, error: err.message, status: err.status });
  }
};
