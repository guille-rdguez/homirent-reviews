const { json, methodNotAllowed, serverError } = require('./_dashboard');
const { processInboundMessage, requireInboundAccess } = require('./_inbound_email');
const { createSupabaseHeaders, getSupabaseConfig, readErrorText } = require('./_dashboard');

async function getPendingMessages(status = 'needs_review') {
  const { url } = getSupabaseConfig();
  const params = new URLSearchParams({
    select: 'id',
    parse_status: `eq.${status}`,
    connector: 'eq.email',
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
    const messages = await getPendingMessages('needs_review');
    let matched = 0;
    let ignored = 0;
    let errors = 0;

    for (const { id } of messages) {
      try {
        const result = await processInboundMessage({ inboundMessageId: id, force: false });
        if (result.status === 'matched') matched++;
        else if (result.status === 'ignored') ignored++;
        else ignored++;
      } catch (err) {
        console.error(`[reprocess-batch] Error en ${id}:`, err.message);
        errors++;
      }
    }

    return json(200, {
      ok: true,
      total: messages.length,
      matched,
      ignored,
      errors,
    });
  } catch (err) {
    console.error('[reprocess-batch]', err);
    return serverError(err.message || 'Error en reprocess batch');
  }
};
