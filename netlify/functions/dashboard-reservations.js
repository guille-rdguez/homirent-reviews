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

  try {
    const { url } = getSupabaseConfig();
    const headers = createSupabaseHeaders();

    const reservationParams = new URLSearchParams({
      select: 'id,guest_name,room_name,status,channel,check_in,check_out,property_id',
      order: 'check_out.desc',
      limit: '2000',
    });
    const propertyParams = new URLSearchParams({
      select: 'id,name,city',
      active: 'eq.true',
    });

    const [reservationsRes, propertiesRes] = await Promise.all([
      fetch(`${url}/rest/v1/reservations?${reservationParams.toString()}`, { headers }),
      fetch(`${url}/rest/v1/properties?${propertyParams.toString()}`, { headers }),
    ]);

    if (!reservationsRes.ok || !propertiesRes.ok) {
      const details = [
        !reservationsRes.ok ? await readErrorText(reservationsRes) : '',
        !propertiesRes.ok ? await readErrorText(propertiesRes) : '',
      ]
        .filter(Boolean)
        .join(' | ');
      return serverError(details || 'No se pudieron cargar las reservaciones de Cloudbeds');
    }

    const [reservations, properties] = await Promise.all([
      reservationsRes.json(),
      propertiesRes.json(),
    ]);
    const propertyMap = new Map(
      (Array.isArray(properties) ? properties : []).map((property) => [property.id, property])
    );
    const rows = (Array.isArray(reservations) ? reservations : []).map((reservation) => ({
      ...reservation,
      properties: propertyMap.get(reservation.property_id) || null,
    }));

    return json(200, { ok: true, reservations: rows });
  } catch (err) {
    console.error(err);
    return serverError(err.message || 'No se pudieron cargar las reservaciones de Cloudbeds');
  }
};
