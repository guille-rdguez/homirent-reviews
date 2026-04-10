const { methodNotAllowed, parseJsonBody, serverError } = require('./_dashboard');
const {
  json,
  processInboundMessage,
  requireInboundAccess,
} = require('./_inbound_email');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed('POST');

  try {
    const access = await requireInboundAccess(event);
    if (!access.ok) return access.error;

    const payload = parseJsonBody(event.body);
    if (payload === null) return serverError('Body JSON invalido', 400);

    const result = await processInboundMessage({
      inboundMessageId: payload?.inboundMessageId,
      externalMessageId: payload?.externalMessageId,
      connector: payload?.connector,
      force: Boolean(payload?.force),
    });

    return json(200, {
      ok: true,
      authMode: access.mode,
      ...result,
    });
  } catch (error) {
    console.error(error);
    return serverError(error.message || 'No se pudo procesar inbound message', 500);
  }
};
