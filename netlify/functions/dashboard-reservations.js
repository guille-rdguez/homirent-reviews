const {
  createSupabaseHeaders,
  getSupabaseConfig,
  json,
  methodNotAllowed,
  readErrorText,
  requireSession,
  serverError,
} = require('./_dashboard');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed('GET');

  const { error } = requireSession(event);
  if (error) return error;

  const { url } = getSupabaseConfig();
  const headers = createSupabaseHeaders();

  const params = new URLSearchParams({
    select: 'id,guest_name,room_name,status,channel,check_in,check_out,booked_at,property_id,properties(name,city)',
    order: 'check_out.desc',
    limit: '2000',
  });

  const response = await fetch(`${url}/rest/v1/reservations?${params}`, { headers });

  if (!response.ok) {
    const details = await readErrorText(response);
    return serverError(details || `Supabase devolvio ${response.status} al leer reservations`);
  }

  const reservations = await response.json();
  return json(200, { ok: true, reservations: Array.isArray(reservations) ? reservations : [] });
};
