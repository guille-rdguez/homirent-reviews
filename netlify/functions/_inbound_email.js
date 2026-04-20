const crypto = require('crypto');

const {
  createSupabaseHeaders,
  getSupabaseConfig,
  json,
  readErrorText,
  requireSession,
  unauthorized,
} = require('./_dashboard');

const DEFAULT_MATCH_THRESHOLD = 0.85;
const REVIEW_LOOKBACK_DAYS = 120;

function getHeader(headers = {}, name) {
  const lowered = String(name).toLowerCase();
  const direct = headers[name];
  if (direct !== undefined) return direct;
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === lowered) return value;
  }
  return undefined;
}

function normalizeText(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeKey(value) {
  return normalizeText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function slugify(value) {
  return normalizeKey(value).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function stripHtml(html) {
  return normalizeText(
    String(html || '')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
  );
}

function extractFirstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) return normalizeText(match[1]);
  }
  return '';
}

function toIsoDateTime(value) {
  const raw = normalizeText(value);
  if (!raw) return new Date().toISOString();
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function subtractDays(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function buildCorpus({ fromEmail, subject, rawText, rawHtml }) {
  return normalizeText(
    [fromEmail, subject, rawText, stripHtml(rawHtml)]
      .filter(Boolean)
      .join('\n')
  );
}

function inferChannel({ fromEmail, subject, rawText, rawHtml, sourceAccount }) {
  const directConnector = normalizeKey(sourceAccount?.connector);
  if (['airbnb', 'booking', 'expedia'].includes(directConnector)) {
    return directConnector;
  }

  const corpus = normalizeKey(
    [fromEmail, subject, rawText, stripHtml(rawHtml), sourceAccount?.label]
      .filter(Boolean)
      .join(' ')
  );
  if (!corpus) return null;
  if (corpus.includes('airbnb')) return 'airbnb';
  if (corpus.includes('expedia')) return 'expedia';
  if (corpus.includes('booking.com') || corpus.includes('booking com')) return 'booking';
  if (corpus.includes('vrbo') || corpus.includes('homeaway')) return 'vrbo';
  return null;
}

function inferConnector(explicitConnector, sourceAccount, channelGuess) {
  const explicit = normalizeText(explicitConnector);
  if (explicit) return explicit;
  const accountConnector = normalizeText(sourceAccount?.connector);
  if (accountConnector && accountConnector !== 'email') return accountConnector;
  if (channelGuess === 'airbnb' && accountConnector === 'airbnb') return 'airbnb';
  return accountConnector || 'email';
}

function classifyMessageType({ subject, rawText, rawHtml, channelGuess }) {
  const corpus = normalizeKey([subject, rawText, stripHtml(rawHtml)].filter(Boolean).join(' '));
  if (
    corpus.includes('review') ||
    corpus.includes('resena') ||
    corpus.includes('reseña') ||
    corpus.includes('rating') ||
    corpus.includes('stars') ||
    corpus.includes('estrellas') ||
    corpus.includes('calificacion') ||
    corpus.includes('calificación')
  ) {
    return 'review_notification';
  }
  if (
    corpus.includes('reservation confirmed') ||
    corpus.includes('reservation confirmation') ||
    corpus.includes('confirmacion de reserva') ||
    corpus.includes('confirmación de reserva') ||
    corpus.includes('new reservation') ||
    corpus.includes('nueva reserva')
  ) {
    return 'reservation_confirmation';
  }
  if (
    corpus.includes('message from your guest') ||
    corpus.includes('mensaje de tu huesped') ||
    corpus.includes('mensaje de tu huésped') ||
    corpus.includes('guest message')
  ) {
    return 'guest_message';
  }
  if (
    corpus.includes('leave a review') ||
    corpus.includes('deja una resena') ||
    corpus.includes('deja una reseña') ||
    corpus.includes('share your feedback')
  ) {
    return 'post_stay_prompt';
  }
  if (channelGuess === 'airbnb' && corpus.includes('guest')) return 'guest_message';
  return 'other';
}

function extractRating(corpus) {
  // Expedia usa escala 1-10 con etiqueta (ej. "6.0 Bueno", "10.0 Excelente") — convertir a 1-5
  const expediaMatch = /\b(10(?:[.,]0)?|[1-9](?:[.,]\d{1,2})?)\s+(?:Decepcionante|Regular|Aceptable|Bueno|Muy\s+bueno|Excelente|Poor|Fair|Good|Very\s+Good|Excellent|Disappointing|Terrible)\b/i.exec(corpus);
  if (expediaMatch?.[1]) {
    const raw = Number.parseFloat(String(expediaMatch[1]).replace(',', '.'));
    if (Number.isFinite(raw) && raw >= 1 && raw <= 10) {
      return Math.max(1, Math.min(5, Math.round(raw / 2)));
    }
  }

  // Escala estándar 1-5
  const patterns = [
    /(?:rating|calificacion|calificación|stars|estrellas)[^\d]{0,10}([1-5](?:[.,]\d)?)(?:\s*\/\s*5)?/i,
    /([1-5](?:[.,]\d)?)\s*\/\s*5/i,
    /([1-5])\s*(?:stars|estrellas)\b/i,
    /\bpuntaje[^\d]{0,10}([1-5](?:[.,]\d)?)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(corpus);
    if (!match?.[1]) continue;
    const rating = Number.parseFloat(String(match[1]).replace(',', '.'));
    if (Number.isFinite(rating) && rating >= 1 && rating <= 5) {
      return Math.round(rating);
    }
  }
  return null;
}

// Detecta si un texto es boilerplate de email de notificación (no comentario real)
const EMAIL_BOILERPLATE = [
  'preheader text here',
  'responda pronto a sus hu',
  'ver en el navegador',
  'tiene un nuevo comentario',
  'un hu\u00e9sped que se qued\u00f3',
  'aparece en los sitios de expedia',
  'take a minute to respond',
  'noreply@expedia',
];
function isBoilerplate(text) {
  const lower = text.toLowerCase();
  return EMAIL_BOILERPLATE.some((b) => lower.includes(b));
}

function extractReviewText(rawText, rawHtml) {
  const text = normalizeText(rawText || stripHtml(rawHtml));
  if (!text) return '';

  // Expedia: el comentario aparece entre la etiqueta de calificación y el nombre+fecha del huésped
  const expediaComment = /(?:Decepcionante|Regular|Aceptable|Bueno|Muy\s+bueno|Excelente|Poor|Fair|Good|Very\s+Good|Excellent|Disappointing|Terrible)\s+([\s\S]{20,2000}?)\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)\s+\d{1,2}\b/i.exec(text);
  if (expediaComment?.[1]) {
    const comment = normalizeText(expediaComment[1]);
    if (comment.length >= 15 && !isBoilerplate(comment)) return comment;
  }

  const labeled = extractFirstMatch(text, [
    /(?:review|comentario|comment|feedback)\s*[:\-]\s*[“”]?(.{10,500})[“”]?/i,
  ]);
  if (labeled && !isBoilerplate(labeled)) return labeled;

  const quoted = extractFirstMatch(text, [/[\””](.{12,500}?)[\””]/]);
  if (quoted && !isBoilerplate(quoted)) return quoted;

  // Fallback: primera frase significativa — solo si no es boilerplate de email
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((part) => normalizeText(part))
    .filter((part) => part.length >= 20 && !isBoilerplate(part));
  return sentences[0] || '';
}

function parseInboundFields({ rawText, rawHtml, subject, headers }) {
  const text = [normalizeText(rawText), stripHtml(rawHtml), normalizeText(subject)]
    .filter(Boolean)
    .join('\n');
  const headerText =
    typeof headers === 'object' && headers
      ? Object.entries(headers)
          .map(([key, value]) => `${key}: ${value}`)
          .join('\n')
      : '';
  const corpus = `${text}\n${headerText}`;

  const guestName = extractFirstMatch(corpus, [
    /(?:guest|hu[eé]sped|traveler|traveller|usuario)\s*(?:name)?\s*[:\-]\s*([A-ZÁÉÍÓÚÑ][^\n<]{2,80})/i,
    /review from\s+([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ’’.\-\s]{2,80})/i,
    /reseña de\s+([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ’’.\-\s]{2,80})/i,
    // Expedia: nombre con mayúscula inicial real (sin /i para no capturar palabras en minúscula del comentario)
    // Ej: "Sonia Apr 13", "Felix Antonio Valdez Apr 13", "Cruz Cazares Apr 13"
    /([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ’\-]+){0,2})\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)\s+\d{1,2}\b/,
    // Expedia: nombre en mayúsculas (SONIA, GERARDO) — solo una o dos palabras
    /([A-ZÁÉÍÓÚÑ]{3,}(?:\s+[A-ZÁÉÍÓÚÑ]{3,})?)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)\s+\d{1,2}\b/,
  ]);

  // Expedia/OTA: property name in greeting "Hola, {Property}:" or "Hello, {Property}:"
  const propertyNameHint = extractFirstMatch(corpus, [
    /(?:Hola|Hello),\s+([^:,<\n]{3,120}):/i,
  ]);

  // Expedia: URL del botón "Ver y responder" / "View and respond" en el HTML
  const reviewUrl = (() => {
    if (!rawHtml) return '';
    const m = /href="(https:\/\/link\.expediapartnercentral\.com\/[^"]+)"[^>]*>[\s\S]{0,200}?(?:Ver\s+y\s+responder|View\s+and\s+respond)/i.exec(rawHtml);
    if (m?.[1]) return m[1];
    // fallback: primer link de expediapartnercentral que no sea imagen ni unsubscribe
    const m2 = /href="(https:\/\/link\.expediapartnercentral\.com\/c\/[^"]+)"/i.exec(rawHtml);
    return m2?.[1] || '';
  })();

  const externalReservationId = extractFirstMatch(corpus, [
    /(?:reservation|booking|confirmation|reserva)\s*(?:id|code|number|no\.?|#)?\s*[:\-]?\s*([A-Z0-9\-]{5,40})/i,
  ]);

  const externalReviewId = extractFirstMatch(corpus, [
    /(?:review)\s*(?:id|number|no\.?|#)?\s*[:\-]?\s*([A-Z0-9_\-]{4,60})/i,
  ]);

  const listingIdHint = extractFirstMatch(corpus, [
    /(?:listing|anuncio|propiedad)\s*(?:id|code|number|no\.?|#)?\s*[:\-]?\s*([A-Z0-9_\-]{3,60})/i,
  ]);

  const listingName = extractFirstMatch(corpus, [
    /(?:listing|anuncio|property|propiedad|accommodation)\s*(?:name)?\s*[:\-]\s*([^\n<]{3,120})/i,
  ]);

  const reviewText = extractReviewText(rawText, rawHtml);
  const rating = extractRating(corpus);

  return {
    guestName: guestName || null,
    externalReservationId: externalReservationId || null,
    externalReviewId: externalReviewId || null,
    listingIdHint: listingIdHint || null,
    listingName: listingName || null,
    propertyNameHint: propertyNameHint || null,
    rating,
    reviewText: reviewText || null,
    reviewUrl: reviewUrl || null,
  };
}

function messageHash(payload) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        fromEmail: payload.fromEmail || '',
        subject: payload.subject || '',
        receivedAt: payload.receivedAt || '',
        rawText: payload.rawText || '',
        rawHtml: payload.rawHtml || '',
      })
    )
    .digest('hex');
}

function getInboundConfig() {
  const rawThreshold = Number.parseFloat(process.env.INBOUND_AUTO_MATCH_THRESHOLD || '');
  return {
    secret: normalizeText(process.env.INBOUND_EMAIL_SECRET) || null,
    autoMatchThreshold:
      Number.isFinite(rawThreshold) && rawThreshold > 0 && rawThreshold <= 1
        ? rawThreshold
        : DEFAULT_MATCH_THRESHOLD,
  };
}

async function requireInboundAccess(event) {
  const config = getInboundConfig();
  const secretHeader =
    getHeader(event.headers, 'x-inbound-secret') ||
    getHeader(event.headers, 'x-process-secret') ||
    getHeader(event.headers, 'x-sync-secret');

  if (config.secret && secretHeader === config.secret) {
    return { ok: true, mode: 'secret' };
  }

  const { error, session } = requireSession(event);
  if (!error && session) {
    return { ok: true, mode: 'session', session };
  }

  if (config.secret) {
    return {
      ok: false,
      error: unauthorized('Secret o sesión requerida para endpoints de inbound email'),
    };
  }

  return {
    ok: false,
    error: unauthorized(
      'Sesion requerida. Opcionalmente define INBOUND_EMAIL_SECRET para automatizaciones'
    ),
  };
}

async function supabaseSelect(path) {
  const { url } = getSupabaseConfig();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: createSupabaseHeaders(),
  });
  if (!response.ok) {
    const details = await readErrorText(response);
    throw new Error(details || `Supabase devolvio ${response.status} al consultar ${path}`);
  }
  return response.json();
}

async function supabaseInsert(path, rows, prefer = 'return=representation') {
  const { url } = getSupabaseConfig();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method: 'POST',
    headers: createSupabaseHeaders({
      'Content-Type': 'application/json',
      Prefer: prefer,
    }),
    body: JSON.stringify(rows),
  });
  if (!response.ok) {
    const details = await readErrorText(response);
    throw new Error(details || `Supabase devolvio ${response.status} al insertar en ${path}`);
  }
  try {
    return await response.json();
  } catch (error) {
    return [];
  }
}

async function supabasePatch(path, patch) {
  const { url } = getSupabaseConfig();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: createSupabaseHeaders({
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    }),
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    const details = await readErrorText(response);
    throw new Error(details || `Supabase devolvio ${response.status} al actualizar ${path}`);
  }
  try {
    return await response.json();
  } catch (error) {
    return [];
  }
}

async function findSourceAccount({ sourceAccountId, externalAccountId, inboxAddress, connector }) {
  if (sourceAccountId) {
    const rows = await supabaseSelect(
      `source_accounts?select=*&id=eq.${encodeURIComponent(sourceAccountId)}&limit=1`
    );
    return rows[0] || null;
  }

  if (connector && externalAccountId) {
    const rows = await supabaseSelect(
      `source_accounts?select=*&connector=eq.${encodeURIComponent(
        connector
      )}&external_account_id=eq.${encodeURIComponent(externalAccountId)}&limit=1`
    );
    if (rows[0]) return rows[0];
  }

  if (connector && inboxAddress) {
    const rows = await supabaseSelect(
      `source_accounts?select=*&connector=eq.${encodeURIComponent(
        connector
      )}&inbox_address=eq.${encodeURIComponent(inboxAddress)}&limit=1`
    );
    if (rows[0]) return rows[0];
  }

  if (inboxAddress) {
    const rows = await supabaseSelect(
      `source_accounts?select=*&inbox_address=eq.${encodeURIComponent(inboxAddress)}&limit=1`
    );
    return rows[0] || null;
  }

  return null;
}

async function findExistingInboundMessage({ connector, externalMessageId, internalHash }) {
  if (externalMessageId) {
    const rows = await supabaseSelect(
      `inbound_messages?select=*&connector=eq.${encodeURIComponent(
        connector
      )}&external_message_id=eq.${encodeURIComponent(externalMessageId)}&limit=1`
    );
    if (rows[0]) return rows[0];
  }

  if (internalHash) {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const connectorFilter = connector ? `&connector=eq.${encodeURIComponent(connector)}` : '';
    const rows = await supabaseSelect(
      `inbound_messages?select=id,metadata${connectorFilter}&received_at=gte.${since}&order=received_at.desc&limit=500`
    );
    return (
      rows.find((row) => normalizeText(row?.metadata?.internal_message_hash) === internalHash) ||
      null
    );
  }

  return null;
}

async function storeInboundMessage(payload = {}) {
  const sourceAccount = await findSourceAccount({
    sourceAccountId: payload.sourceAccountId,
    externalAccountId: payload.externalAccountId,
    inboxAddress: payload.inboxAddress,
    connector: payload.accountConnector || payload.connector,
  });

  const rawText = normalizeText(payload.text || payload.rawText);
  const rawHtml = String(payload.html || payload.rawHtml || '');
  const subject = normalizeText(payload.subject);
  const fromEmail = normalizeText(payload.fromEmail || payload.from_email);
  const receivedAt = toIsoDateTime(payload.receivedAt || payload.received_at);
  const headers = payload.headers && typeof payload.headers === 'object' ? payload.headers : {};
  const channelGuess = inferChannel({ fromEmail, subject, rawText, rawHtml, sourceAccount });
  const connector = inferConnector(payload.connector, sourceAccount, channelGuess);
  const messageType = classifyMessageType({ subject, rawText, rawHtml, channelGuess });
  const parsedFields = parseInboundFields({ rawText, rawHtml, subject, headers });
  const internalHash = messageHash({ fromEmail, subject, receivedAt, rawText, rawHtml });
  const externalMessageId = normalizeText(payload.externalMessageId || payload.messageId);
  const threadId = normalizeText(payload.threadId);
  const existing = await findExistingInboundMessage({
    connector,
    externalMessageId,
    internalHash,
  });

  const row = {
    source_account_id: sourceAccount?.id || null,
    connector,
    channel_guess: channelGuess,
    external_message_id: externalMessageId || null,
    thread_id: threadId || null,
    from_email: fromEmail || null,
    subject: subject || null,
    received_at: receivedAt,
    parse_status: 'parsed',
    raw_text: rawText || null,
    raw_html: rawHtml || null,
    headers,
    metadata: {
      provider: normalizeText(payload.provider) || 'manual',
      inbox_address: normalizeText(payload.inboxAddress) || sourceAccount?.inbox_address || null,
      message_type: messageType,
      parsed_fields: parsedFields,
      ingested_at: new Date().toISOString(),
      internal_message_hash: internalHash,
    },
  };

  let stored;
  if (existing?.id) {
    const updatedRows = await supabasePatch(
      `inbound_messages?id=eq.${encodeURIComponent(existing.id)}`,
      row
    );
    stored = updatedRows[0] || { ...existing, ...row };
  } else {
    const insertedRows = await supabaseInsert('inbound_messages', row);
    stored = insertedRows[0] || row;
  }

  return {
    message: stored,
    sourceAccount,
    classification: {
      connector,
      channelGuess,
      messageType,
      parsedFields,
    },
  };
}

function listingNameScore(parsedListingName, listing) {
  const target = normalizeKey(parsedListingName);
  if (!target) return { score: 0, reason: null };
  const candidates = [
    normalizeKey(listing.display_name),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === target) return { score: 0.65, reason: 'listing_name_exact' };
  }
  for (const candidate of candidates) {
    if (candidate.includes(target) || target.includes(candidate)) {
      return { score: 0.35, reason: 'listing_name_partial' };
    }
  }
  return { score: 0, reason: null };
}

function isDateWindowMatch(receivedAt, reservation) {
  if (!receivedAt || !reservation?.check_out) return false;
  const reviewDate = new Date(receivedAt);
  const checkoutDate = new Date(`${reservation.check_out}T00:00:00Z`);
  if (Number.isNaN(reviewDate.getTime()) || Number.isNaN(checkoutDate.getTime())) return false;
  const diffDays = Math.floor((reviewDate.getTime() - checkoutDate.getTime()) / 86400000);
  return diffDays >= -2 && diffDays <= 45;
}

function buildReservationCandidate({
  reservation,
  listing,
  parsed,
  message,
}) {
  let score = 0;
  const reasons = [];

  if (
    parsed.externalReservationId &&
    normalizeText(reservation.external_reservation_id) === normalizeText(parsed.externalReservationId)
  ) {
    score += 0.75;
    reasons.push('external_reservation_id');
  }

  if (
    parsed.guestName &&
    normalizeKey(reservation.guest_name) === normalizeKey(parsed.guestName)
  ) {
    score += 0.1;
    reasons.push('guest_name');
  }

  if (message.source_account_id && reservation.source_account_id === message.source_account_id) {
    score += 0.1;
    reasons.push('source_account');
  }

  if (message.channel_guess && reservation.channel === message.channel_guess) {
    score += 0.05;
    reasons.push('channel');
  }

  if (listing) {
    const listingScore = listingNameScore(parsed.listingName || parsed.listingIdHint, listing);
    if (listingScore.score) {
      score += Math.min(0.25, listingScore.score);
      reasons.push(listingScore.reason);
    }
  }

  if (isDateWindowMatch(message.received_at, reservation)) {
    score += 0.1;
    reasons.push('date_window');
  }

  return {
    type: 'reservation',
    score: Math.min(1, Number(score.toFixed(4))),
    reasons,
    reservation,
    listing,
    propertyId: reservation.property_id,
    reservationId: reservation.id,
    listingId: reservation.listing_id || listing?.id || null,
    sourceAccountId: reservation.source_account_id || message.source_account_id || null,
  };
}

function buildListingCandidate({ listing, parsed, message }) {
  let score = 0;
  const reasons = [];

  if (
    parsed.listingIdHint &&
    normalizeText(listing.external_listing_id) === normalizeText(parsed.listingIdHint)
  ) {
    score += 0.75;
    reasons.push('listing_id_exact');
  } else {
    const listingScore = listingNameScore(parsed.listingName, listing);
    if (listingScore.score) {
      score += listingScore.score;
      reasons.push(listingScore.reason);
    }
  }

  if (message.source_account_id && listing.source_account_id === message.source_account_id) {
    score += 0.15;
    reasons.push('source_account');
  }

  if (message.channel_guess && listing.channel === message.channel_guess) {
    score += 0.05;
    reasons.push('channel');
  }

  return {
    type: 'listing',
    score: Math.min(1, Number(score.toFixed(4))),
    reasons,
    reservation: null,
    listing,
    propertyId: listing.property_id,
    reservationId: null,
    listingId: listing.id,
    sourceAccountId: listing.source_account_id || message.source_account_id || null,
  };
}

async function loadProcessingContext(message) {
  const channel = normalizeText(message.channel_guess || '') || null;
  const channelFilter = channel ? `&channel=eq.${encodeURIComponent(channel)}` : '';
  const listings = await supabaseSelect(
    `external_listings?select=id,property_id,source_account_id,connector,channel,external_listing_id,external_property_id,display_name,metadata&active=eq.true${channelFilter}&limit=500`
  );
  const reservations = await supabaseSelect(
    `reservations?select=id,property_id,listing_id,source_account_id,channel,external_reservation_id,guest_name,room_name,check_in,check_out,status&check_out=gte.${subtractDays(
      REVIEW_LOOKBACK_DAYS
    )}${channelFilter}&order=check_out.desc&limit=1000`
  );
  return {
    listings: Array.isArray(listings) ? listings : [],
    reservations: Array.isArray(reservations) ? reservations : [],
  };
}

async function findPropertyByName(nameHint) {
  if (!nameHint) return null;
  const hint = normalizeKey(nameHint);
  if (hint.length < 3) return null;
  const properties = await supabaseSelect('properties?select=id,name&limit=100');
  let best = null;
  let bestScore = 0;
  for (const prop of properties) {
    const propName = normalizeKey(prop.name || '');
    if (!propName) continue;
    if (propName === hint) return prop;
    const hintWords = hint.split(/\s+/).filter((w) => w.length > 2);
    const propWords = propName.split(/\s+/).filter((w) => w.length > 2);
    const matchCount = hintWords.filter((w) => propWords.includes(w)).length;
    const score = matchCount / Math.max(hintWords.length, propWords.length, 1);
    if (score > bestScore) { bestScore = score; best = prop; }
  }
  return bestScore >= 0.5 ? best : null;
}

function chooseBestCandidate(message, parsed, context) {
  const listingsById = new Map(context.listings.map((listing) => [listing.id, listing]));
  const candidates = [];

  for (const reservation of context.reservations) {
    const listing = reservation.listing_id ? listingsById.get(reservation.listing_id) : null;
    candidates.push(buildReservationCandidate({ reservation, listing, parsed, message }));
  }

  for (const listing of context.listings) {
    candidates.push(buildListingCandidate({ listing, parsed, message }));
  }

  candidates.sort((left, right) => right.score - left.score);
  return {
    best: candidates[0] || null,
    topCandidates: candidates.slice(0, 5),
  };
}

async function findExistingReview({ channel, externalReviewId }) {
  if (!externalReviewId) return null;
  const rows = await supabaseSelect(
    `reviews?select=id,external_review_id,channel&external_review_id=eq.${encodeURIComponent(
      externalReviewId
    )}&channel=eq.${encodeURIComponent(channel)}&limit=1`
  );
  return rows[0] || null;
}

async function createOrUpdateReview({ message, parsed, match }) {
  if (!match?.propertyId) {
    throw new Error('No se puede crear review sin property_id resuelto');
  }

  const reviewBody = {
    property_id: match.propertyId,
    source_account_id: match.sourceAccountId || null,
    listing_id: match.listingId || null,
    reservation_id: match.reservationId || null,
    connector: message.connector || 'email',
    channel: message.channel_guess || 'unknown',
    source_type: 'email_parsed',
    external_review_id: parsed.externalReviewId || null,
    guest_name: parsed.guestName || null,
    room_name: match.reservation?.room_name || null,
    rating: parsed.rating,
    comment: parsed.reviewText || null,
    would_return: null,
    source: `${message.channel_guess || message.connector || 'email'}-email`,
    reviewed_at: message.received_at || new Date().toISOString(),
    is_public: true,
    match_confidence: match.score,
    response_status: 'pending',
    raw_payload: {
      inbound_message_id: message.id,
      parsed_fields: parsed,
    },
    metadata: {
      inbound_message_id: message.id,
      match_reasons: match.reasons,
      match_type: match.type,
    },
  };

  const existing = await findExistingReview({
    channel: reviewBody.channel,
    externalReviewId: reviewBody.external_review_id,
  });

  if (existing?.id) {
    const updatedRows = await supabasePatch(
      `reviews?id=eq.${encodeURIComponent(existing.id)}`,
      reviewBody
    );
    return updatedRows[0] || { id: existing.id, ...reviewBody };
  }

  const insertedRows = await supabaseInsert('reviews', reviewBody);
  return insertedRows[0] || reviewBody;
}

async function getInboundMessage({ inboundMessageId, externalMessageId, connector }) {
  if (inboundMessageId) {
    const rows = await supabaseSelect(
      `inbound_messages?select=*&id=eq.${encodeURIComponent(inboundMessageId)}&limit=1`
    );
    return rows[0] || null;
  }
  if (externalMessageId && connector) {
    const rows = await supabaseSelect(
      `inbound_messages?select=*&connector=eq.${encodeURIComponent(
        connector
      )}&external_message_id=eq.${encodeURIComponent(externalMessageId)}&limit=1`
    );
    return rows[0] || null;
  }
  return null;
}

async function processInboundMessage({ inboundMessageId, externalMessageId, connector, force = false }) {
  const message = await getInboundMessage({ inboundMessageId, externalMessageId, connector });
  if (!message?.id) {
    throw new Error('Inbound message no encontrado');
  }

  // Re-parsear con el parser actualizado para obtener campos nuevos (ej. propertyNameHint)
  const freshParsed = parseInboundFields({
    rawText: message.raw_text,
    rawHtml: message.raw_html,
    subject: message.subject,
    headers: message.headers,
  });
  const parsed = { ...(message.metadata?.parsed_fields || {}), ...freshParsed };
  const messageType = message.metadata?.message_type || 'other';
  if (!force && messageType !== 'review_notification') {
    const updatedRows = await supabasePatch(
      `inbound_messages?id=eq.${encodeURIComponent(message.id)}`,
      {
        parse_status: 'ignored',
        metadata: {
          ...(message.metadata || {}),
          processing: {
            processed_at: new Date().toISOString(),
            ignored_reason: 'message_type_not_review',
          },
        },
      }
    );
    return {
      status: 'ignored',
      message: updatedRows[0] || message,
      reason: 'message_type_not_review',
    };
  }

  const context = await loadProcessingContext(message);
  const { best, topCandidates } = chooseBestCandidate(message, parsed, context);
  const threshold = getInboundConfig().autoMatchThreshold;
  let shouldCreateReview =
    Boolean(best) &&
    best.score >= threshold &&
    (Boolean(best.propertyId) || Boolean(best.reservationId));

  let matchToUse = best;

  // Fallback: si el matching estándar no alcanzó el umbral, buscar por nombre de propiedad
  // No requerimos rating — algunos emails de Expedia son solo notificaciones sin el contenido embebido
  if (!shouldCreateReview && parsed.propertyNameHint) {
    const propByName = await findPropertyByName(parsed.propertyNameHint);
    if (propByName) {
      matchToUse = {
        type: 'property_name_hint',
        score: 0.7,
        reasons: ['property_name_hint'],
        reservation: null,
        listing: null,
        propertyId: propByName.id,
        reservationId: null,
        listingId: null,
        sourceAccountId: message.source_account_id || null,
      };
      shouldCreateReview = true;
    }
  }

  let review = null;
  let status = 'needs_review';

  if (shouldCreateReview) {
    review = await createOrUpdateReview({ message, parsed, match: matchToUse });
    status = 'matched';
  }

  const updatedRows = await supabasePatch(
    `inbound_messages?id=eq.${encodeURIComponent(message.id)}`,
    {
      property_id: matchToUse?.propertyId || null,
      reservation_id: matchToUse?.reservationId || null,
      parse_status: status,
      metadata: {
        ...(message.metadata || {}),
        processing: {
          processed_at: new Date().toISOString(),
          status,
          threshold,
          best_candidate: best,
          top_candidates: topCandidates,
          review_id: review?.id || null,
          missing_rating: !parsed.rating,
        },
      },
    }
  );

  return {
    status,
    threshold,
    message: updatedRows[0] || message,
    bestCandidate: best,
    topCandidates,
    review,
  };
}

module.exports = {
  json,
  processInboundMessage,
  requireInboundAccess,
  storeInboundMessage,
};
