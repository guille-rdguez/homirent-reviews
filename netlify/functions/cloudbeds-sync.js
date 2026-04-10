const {
  json,
  requireSyncAccess,
  syncCloudbedsReservations,
} = require('./_cloudbeds');
const { methodNotAllowed, parseJsonBody, serverError } = require('./_dashboard');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed('POST');

  try {
    const access = await requireSyncAccess(event);
    if (!access.ok) return access.error;

    const payload = parseJsonBody(event.body);
    if (payload === null) return serverError('Body JSON invalido', 400);

    const result = await syncCloudbedsReservations(payload || {});
    return json(200, {
      ok: true,
      authMode: access.mode,
      ...result,
    });
  } catch (error) {
    console.error(error);
    const statusCode =
      String(error.message || '').includes('Sesion requerida') ||
      String(error.message || '').includes('Secret o sesión')
        ? 401
        : 500;
    return serverError(error.message || 'No se pudo ejecutar cloudbeds-sync', statusCode);
  }
};
