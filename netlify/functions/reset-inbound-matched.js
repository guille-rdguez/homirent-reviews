const {
  json,
  methodNotAllowed,
  serverError,
  createSupabaseHeaders,
  getSupabaseConfig,
  readErrorText,
  requireSession,
} = require('./_dashboard');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed('POST');

  const { error } = requireSession(event);
  if (error) return error;

  const { url } = getSupabaseConfig();

  try {
    // Contar cuántos mensajes matched hay antes de resetear
    const countRes = await fetch(
      `${url}/rest/v1/inbound_messages?select=id&parse_status=eq.matched&order=received_at.asc`,
      { headers: { ...createSupabaseHeaders(), Prefer: 'count=exact' } }
    );
    const total = Number(countRes.headers.get('content-range')?.split('/')[1] || 0);

    // Resetear todos los matched a needs_review
    const patchRes = await fetch(
      `${url}/rest/v1/inbound_messages?parse_status=eq.matched`,
      {
        method: 'PATCH',
        headers: {
          ...createSupabaseHeaders(),
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ parse_status: 'needs_review' }),
      }
    );

    if (!patchRes.ok) {
      const details = await readErrorText(patchRes);
      return serverError(details || `Supabase devolvio ${patchRes.status}`);
    }

    return json(200, { ok: true, reset: total });
  } catch (err) {
    console.error('[reset-inbound-matched]', err);
    return serverError(err.message || 'Error al resetear mensajes');
  }
};
