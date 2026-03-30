const {
  json,
  methodNotAllowed,
} = require('./_dashboard');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed('POST');
  return json(200, { ok: true });
};
