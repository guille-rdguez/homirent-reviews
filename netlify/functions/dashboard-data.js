const {
  fetchDashboardData,
  json,
  methodNotAllowed,
  requireSession,
  serverError,
} = require('./_dashboard');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed('GET');

  const { error } = requireSession(event);
  if (error) return error;

  try {
    const data = await fetchDashboardData();
    return json(200, { ok: true, ...data });
  } catch (error) {
    console.error(error);
    return serverError(error.message || 'No se pudo cargar el dashboard');
  }
};
