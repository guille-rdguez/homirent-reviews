const { methodNotAllowed, parseJsonBody, serverError } = require('./_dashboard');
const {
  json,
  processInboundMessage,
  requireInboundAccess,
  storeInboundMessage,
} = require('./_inbound_email');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed('POST');

  try {
    const access = await requireInboundAccess(event);
    if (!access.ok) return access.error;

    const payload = parseJsonBody(event.body);
    if (payload === null) return serverError('Body JSON invalido', 400);

    const stored = await storeInboundMessage(payload || {});
    let processing = null;

    if (payload?.autoProcess === true && stored?.message?.id) {
      processing = await processInboundMessage({
        inboundMessageId: stored.message.id,
        force: Boolean(payload.force),
      });
    }

    return json(200, {
      ok: true,
      authMode: access.mode,
      ...stored,
      processing,
    });
  } catch (error) {
    console.error(error);
    return serverError(error.message || 'No se pudo procesar inbound email', 500);
  }
};
