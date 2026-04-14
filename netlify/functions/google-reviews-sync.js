const { syncGoogleReviews } = require('./_google_reviews');
const { json, methodNotAllowed, serverError } = require('./_dashboard');
const { requireSyncAccess } = require('./_cloudbeds');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed('POST');

  const access = await requireSyncAccess(event);
  if (!access.ok) return access.error;

  try {
    const result = await syncGoogleReviews();
    return json(200, { ok: true, authMode: access.mode, ...result });
  } catch (error) {
    console.error(error);
    return serverError(error.message || 'No se pudo ejecutar google-reviews-sync');
  }
};
