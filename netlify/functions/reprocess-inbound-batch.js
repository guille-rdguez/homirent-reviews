const { json, methodNotAllowed, serverError, createSupabaseHeaders, getSupabaseConfig, readErrorText } = require('./_dashboard');
const { processInboundMessage, requireInboundAccess } = require('./_inbound_email');

async function getPendingMessages(status = 'needs_review') {
  const { url } = getSupabaseConfig();
  const params = new URLSearchParams({
    select: 'id',
    parse_status: `eq.${status}`,
    order: 'received_at.asc',
    limit: '200',
  });
  const res = await fetch(`${url}/rest/v1/inbound_messages?${params}`, {
    headers: createSupabaseHeaders(),
  });
  if (!res.ok) {
    const details = await readErrorText(res);
    throw new Error(details || `Supabase devolvio ${res.status}`);
  }
  return res.json();
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed('POST');

  const access = await requireInboundAccess(event);
  if (!access.ok) return access.error;

  try {
    const all = await getPendingMessages('needs_review');
    const messages = all.slice(0, 20); // max 20 por llamada para evitar timeout
    let matched = 0;
    let ignored = 0;
    let errors = 0;

    for (const { id } of messages) {
      try {
        const result = await processInboundMessage({ inboundMessageId: id, force: false });
        if (result.status === 'matched') matched++;
        else ignored++;
      } catch (err) {
        console.error(`[reprocess-batch] Error en ${id}:`, err.message);
        errors++;
      }
    }

    return json(200, {
      ok: true,
      processed: messages.length,
      remaining: all.length - messages.length,
      matched,
      ignored,
      errors,
    });
  } catch (err) {
    console.error('[reprocess-batch]', err);
    return serverError(err.message || 'Error en reprocess batch');
  }
};
