const {
  createSupabaseHeaders,
  getSupabaseConfig,
  json,
  methodNotAllowed,
  parseJsonBody,
  readErrorText,
  requireSession,
  serverError,
} = require('./_dashboard');

async function getReviews() {
  const { url } = getSupabaseConfig();
  const headers = createSupabaseHeaders();
  const params = new URLSearchParams({
    select: 'id,guest_name,rating,comment,review_url,place_id,published_at,responded,responded_at,property_id,properties(name,city)',
    order: 'published_at.desc',
  });
  const res = await fetch(`${url}/rest/v1/google_reviews?${params}`, { headers });
  if (!res.ok) {
    const details = await readErrorText(res);
    throw new Error(details || `Supabase devolvio ${res.status}`);
  }
  return res.json();
}

async function markResponded(id, responded) {
  const { url } = getSupabaseConfig();
  const headers = createSupabaseHeaders();
  const body = {
    responded,
    responded_at: responded ? new Date().toISOString() : null,
  };
  const res = await fetch(
    `${url}/rest/v1/google_reviews?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const details = await readErrorText(res);
    throw new Error(details || `Supabase devolvio ${res.status}`);
  }
}

exports.handler = async (event) => {
  const { error } = requireSession(event);
  if (error) return error;

  if (event.httpMethod === 'GET') {
    try {
      const reviews = await getReviews();
      return json(200, { ok: true, reviews });
    } catch (err) {
      return serverError(err.message);
    }
  }

  if (event.httpMethod === 'POST') {
    const payload = parseJsonBody(event.body);
    if (!payload) return serverError('Body JSON invalido', 400);

    const { id, responded } = payload;
    if (!id) return serverError('id es obligatorio', 400);
    if (typeof responded !== 'boolean') return serverError('responded debe ser boolean', 400);

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(id)) return serverError('id invalido', 400);

    try {
      await markResponded(id, responded);
      return json(200, { ok: true });
    } catch (err) {
      return serverError(err.message);
    }
  }

  return methodNotAllowed('GET, POST');
};
