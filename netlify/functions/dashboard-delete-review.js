const {
  deleteReviewById,
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

  const reviewId = String(payload.reviewId || '').trim();
  if (!reviewId) {
    return serverError('reviewId es obligatorio', 400);
  }

  try {
    const result = await deleteReviewById(reviewId);
    if (!result.deleted) {
      return serverError('La review ya no existe o no se pudo borrar', 404);
    }
    return json(200, { ok: true, deleted: true });
  } catch (error) {
    console.error(error);
    return serverError(error.message || 'No se pudo borrar la review');
  }
};
