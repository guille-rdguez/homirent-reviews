const crypto = require('crypto');

const {
  createSupabaseHeaders,
  getSupabaseConfig,
  readErrorText,
} = require('./_dashboard');

const BOOKING_CONNECTOR = 'booking';
const BOOKING_CHANNEL = 'booking';
const BOOKING_SOURCE_TYPE = 'booking_csv';
const BOOKING_SETUP_MIGRATION = '20260428_booking_csv_ingestion.sql';
const BOOKING_MIN_REVIEW_YEAR = 2025;
const GOOGLE_TRANSLATE_ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';
const MAX_TRANSLATE_BATCH_SIZE = 64;
const BOOKING_REVIEW_LINKS = [
  { city: 'Querétaro', name: 'El Doce', url: 'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/reviews.html?hotel_id=8713914&lang=es' },
  { city: 'Querétaro', name: 'Morelos', url: 'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/reviews.html?hotel_id=9262488&lang=es' },
  { city: 'Querétaro', name: 'Hacienda Santa Bárbara', url: 'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/reviews.html?hotel_id=10892046&lang=es' },
  { city: 'Querétaro', name: 'Musgo', url: 'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/reviews.html?hotel_id=12038573&lang=es' },
  { city: 'Querétaro', name: 'Universidad', url: 'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/reviews.html?hotel_id=12815077&lang=es' },
  { city: 'Querétaro', name: 'Liquidambar', url: 'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/reviews.html?hotel_id=14079638&lang=es' },
  { city: 'Querétaro', name: 'Allende', url: 'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/reviews.html?hotel_id=13808497&lang=es' },
  { city: 'Querétaro', name: 'Damian Carmona', url: 'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/reviews.html?hotel_id=15636879&lang=es' },
  { city: 'Querétaro', name: 'Suites Álamos', url: 'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/reviews.html?hotel_id=14786823&lang=es' },
  { city: 'Querétaro', name: 'Ezequiel Montes', url: 'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/reviews.html?hotel_id=14716326&lang=es' },
  { city: 'Querétaro', name: 'Primavera', url: 'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/reviews.html?hotel_id=14546697&lang=es' },
  { city: 'Querétaro', name: 'Pájaros', url: 'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/reviews.html?hotel_id=14537888&lang=es' },
  { city: 'Querétaro', name: 'Wenceslao', url: 'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/reviews.html?hotel_id=14405576&lang=es' },
  { city: 'Ciudad de México', name: 'Balsas', url: 'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/reviews.html?hotel_id=8963209&lang=es' },
  { city: 'Ciudad de México', name: 'Prosperidad', url: 'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/reviews.html?hotel_id=8970236&lang=es' },
  { city: 'Ciudad de México', name: 'Lago Zirahuén', url: 'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/reviews.html?hotel_id=9276359&lang=es' },
  { city: 'Mérida', name: 'Suites Reforma', url: 'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/reviews.html?hotel_id=9537971&lang=es' },
];

const BOOKING_HEADERS = {
  review_date: [
    'review date',
    'fecha de comentario',
    'fecha del comentario',
    'fecha de reseña',
    'fecha de revision',
    'fecha',
  ],
  guest_name: [
    'guest name',
    'nombre del huesped',
    'nombre del huésped',
    'nombre del cliente',
    'huesped',
    'huésped',
    'cliente',
  ],
  reservation_number: [
    'reservation number',
    'numero de reservacion',
    'numero de reserva',
    'número de reservación',
    'número de reserva',
    'reservation id',
  ],
  review_title: ['review title', 'titulo del comentario', 'título del comentario', 'titulo', 'título'],
  positive_review: [
    'positive review',
    'comentario positivo',
    'positivo',
    'lo que mas te gusto',
    'lo que más te gustó',
  ],
  negative_review: [
    'negative review',
    'comentario negativo',
    'negativo',
    'lo que menos te gusto',
    'lo que menos te gustó',
  ],
  review_score: [
    'review score',
    'puntuacion',
    'puntuación',
    'puntuacion del comentario',
    'puntuación del comentario',
    'calificacion',
    'calificación',
  ],
  staff: ['staff', 'personal'],
  cleanliness: ['cleanliness', 'limpieza'],
  location: ['location', 'ubicacion', 'ubicación'],
  facilities: ['facilities', 'instalaciones', 'instalaciones y servicios'],
  comfort: ['comfort', 'comodidad', 'confort'],
  value_for_money: [
    'value for money',
    'relacion calidad precio',
    'relación calidad precio',
    'calidad precio',
    'valor por el dinero',
  ],
  property_reply: ['property reply', 'respuesta del alojamiento', 'respuesta de la propiedad'],
};

const AREA_FIELDS = [
  { key: 'rating_overall_10', sourceKey: 'review_score', label: 'Review score' },
  { key: 'score_staff', sourceKey: 'staff', label: 'Staff' },
  { key: 'score_cleanliness', sourceKey: 'cleanliness', label: 'Cleanliness' },
  { key: 'score_location', sourceKey: 'location', label: 'Location' },
  { key: 'score_facilities', sourceKey: 'facilities', label: 'Facilities' },
  { key: 'score_comfort', sourceKey: 'comfort', label: 'Comfort' },
  { key: 'score_value_for_money', sourceKey: 'value_for_money', label: 'Value for money' },
];

const AREA_DETAILS = [
  { key: 'rating_overall_10', label: 'General' },
  { key: 'score_staff', label: 'Staff' },
  { key: 'score_cleanliness', label: 'Cleanliness' },
  { key: 'score_location', label: 'Location' },
  { key: 'score_facilities', label: 'Facilities' },
  { key: 'score_comfort', label: 'Comfort' },
  { key: 'score_value_for_money', label: 'Value for money' },
];

const BOOKING_REVIEW_LINK_MAP = new Map(
  BOOKING_REVIEW_LINKS.map((item) => [
    `${normalizeDirectoryKey(item.city)}::${normalizeDirectoryKey(item.name)}`,
    item.url,
  ])
);

function normalizeDirectoryKey(value) {
  return String(value || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function detectMissingBookingTableName(message = '') {
  const input = String(message || '');
  return ['booking_review_details', 'booking_import_batches'].find(
    (tableName) => input.includes(`public.${tableName}`) || input.includes(tableName)
  ) || null;
}

function isMissingBookingTableError(message = '') {
  const input = String(message || '');
  return Boolean(
    detectMissingBookingTableName(input) &&
      /PGRST205|schema cache|Could not find the table/i.test(input)
  );
}

function bookingSetupMessage(action = 'usar Booking', tableName = 'booking_review_details') {
  return `Booking necesita la migración de Supabase ${BOOKING_SETUP_MIGRATION} antes de ${action}. Falta la tabla public.${tableName}.`;
}

function toBookingSetupError(error, action = 'usar Booking') {
  const message = String(error?.message || error || '');
  if (!isMissingBookingTableError(message)) {
    return error instanceof Error ? error : new Error(message || 'Error desconocido de Booking');
  }
  const tableName = detectMissingBookingTableName(message) || 'booking_review_details';
  return new Error(bookingSetupMessage(action, tableName));
}

function normalizeText(value) {
  return String(value || '')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeMultilineText(value) {
  return String(value || '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .trim()
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ');
}

function normalizeKey(value) {
  return normalizeText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function decodeCsvBase64(base64Value) {
  const buffer = Buffer.from(String(base64Value || ''), 'base64');
  if (!buffer.length) throw new Error('No se recibio contenido CSV');
  const utf8 = buffer.toString('utf8');
  const latin1 = buffer.toString('latin1');
  return scoreDecodedText(utf8) <= scoreDecodedText(latin1) ? utf8 : latin1;
}

function scoreDecodedText(text) {
  const value = String(text || '');
  const replacementCount = (value.match(/\uFFFD/g) || []).length;
  const mojibakeCount = (value.match(/Ã|Â|â€™|â€œ|â€|ðŸ/g) || []).length;
  return replacementCount * 4 + mojibakeCount;
}

function fixMojibake(value) {
  const input = normalizeMultilineText(value);
  if (!input) return '';
  if (!/[ÃÂâ€™â€œâ€]/.test(input)) return input;
  const repaired = Buffer.from(input, 'latin1').toString('utf8');
  return scoreDecodedText(repaired) < scoreDecodedText(input) ? repaired : input;
}

function cleanTextField(value) {
  const repaired = fixMojibake(value);
  return repaired ? repaired.normalize('NFC') : null;
}

function normalizeHeader(value) {
  return normalizeKey(value).replace(/[^a-z0-9]+/g, ' ');
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }

    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }

    if (char === '\r') {
      if (text[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }

    field += char;
  }

  row.push(field);
  rows.push(row);

  while (rows.length && rows[rows.length - 1].every((item) => !normalizeText(item))) {
    rows.pop();
  }

  return rows;
}

function buildHeaderMap(headerRow = []) {
  const aliases = new Map();
  Object.entries(BOOKING_HEADERS).forEach(([key, values]) => {
    values.forEach((value) => aliases.set(normalizeHeader(value), key));
  });

  const headerMap = {};
  headerRow.forEach((label, index) => {
    const normalized = normalizeHeader(label);
    if (!normalized) return;
    const key = aliases.get(normalized);
    if (key && headerMap[key] === undefined) {
      headerMap[key] = index;
    }
  });

  return headerMap;
}

function listMissingHeaders(headerMap) {
  const required = [
    'review_date',
    'guest_name',
    'reservation_number',
    'review_score',
    'staff',
    'cleanliness',
    'location',
    'facilities',
    'comfort',
    'value_for_money',
  ];
  return required.filter((key) => headerMap[key] === undefined);
}

function getCell(cells, headerMap, key) {
  const index = headerMap[key];
  if (index === undefined) return '';
  return cells[index] ?? '';
}

function parseNumericScore(value) {
  const raw = normalizeText(value).replace(',', '.');
  if (!raw) return null;
  const score = Number.parseFloat(raw);
  return Number.isFinite(score) ? score : null;
}

function scoreToGeneralRating(score10) {
  if (!Number.isFinite(score10)) return null;
  return Math.max(1, Math.min(5, Math.round(score10 / 2)));
}

function scoreToDisplayRating5(score10) {
  if (!Number.isFinite(score10)) return null;
  return Number((Math.max(0.5, Math.min(5, score10 / 2))).toFixed(2));
}

function buildAverageScore(row) {
  const values = AREA_FIELDS.map((field) => row[field.key]).filter((value) => Number.isFinite(value));
  if (!values.length) return null;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4));
}

function buildCombinedComment({ reviewTitle, positiveReview, negativeReview }) {
  const parts = [];
  if (reviewTitle) parts.push(`Titulo: ${reviewTitle}`);
  if (positiveReview) parts.push(`Positivo: ${positiveReview}`);
  if (negativeReview) parts.push(`Negativo: ${negativeReview}`);
  return parts.join('\n\n') || null;
}

function parseReviewDate(value) {
  const raw = normalizeText(value);
  if (!raw) return null;

  const isoMatch = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (isoMatch) {
    const [, year, month, day, hour = '00', minute = '00', second = '00'] = isoMatch;
    return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
  }

  const localMatch = raw.match(
    /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (localMatch) {
    const [, day, month, year, hour = '00', minute = '00', second = '00'] = localMatch;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(
      hour
    ).padStart(2, '0')}:${minute}:${String(second).padStart(2, '0')}Z`;
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return null;
}

function isBookingReviewInScope(reviewDateIso) {
  const year = Number.parseInt(String(reviewDateIso || '').slice(0, 4), 10);
  return Number.isFinite(year) && year >= BOOKING_MIN_REVIEW_YEAR;
}

function sortPreviewRows(rows = []) {
  const priority = {
    parsed: 0,
    duplicate_existing: 1,
    duplicate_in_file: 2,
    invalid: 3,
    out_of_scope: 4,
  };
  return rows.slice().sort((left, right) => {
    const leftPriority = priority[left?.status] ?? 99;
    const rightPriority = priority[right?.status] ?? 99;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    const leftDate = String(left?.reviewDateIso || '');
    const rightDate = String(right?.reviewDateIso || '');
    if (leftDate !== rightDate) return rightDate.localeCompare(leftDate);
    return Number(left?.rowNumber || 0) - Number(right?.rowNumber || 0);
  });
}

function buildBookingReviewKey({ propertyId, reviewDateIso, guestName, reservationNumber }) {
  const dateKey = normalizeText(reviewDateIso);
  const guestKey = normalizeKey(guestName);
  const reservationKey = normalizeText(reservationNumber);
  return `${propertyId}|${dateKey}|${guestKey}|${reservationKey}`;
}

function buildExternalReviewId(reviewKey) {
  return `booking_csv:${sha256Hex(reviewKey)}`;
}

function monthKeyFromIso(value) {
  return String(value || '').slice(0, 7);
}

function fallbackBookingReviewUrl(property = {}) {
  const cityKey = normalizeDirectoryKey(property?.city);
  const nameKey = normalizeDirectoryKey(property?.name);
  if (!cityKey || !nameKey) return '';
  return BOOKING_REVIEW_LINK_MAP.get(`${cityKey}::${nameKey}`) || '';
}

function chunk(items, size = 100) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

async function listActiveProperties() {
  const { url } = getSupabaseConfig();
  const headers = createSupabaseHeaders();
  const params = new URLSearchParams({
    select: 'id,name,city',
    active: 'eq.true',
    order: 'city,name',
  });
  const res = await fetch(`${url}/rest/v1/properties?${params.toString()}`, { headers });
  if (!res.ok) {
    const details = await readErrorText(res);
    throw new Error(details || `Supabase devolvio ${res.status} al leer properties`);
  }
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

async function getPropertyById(propertyId) {
  const { url } = getSupabaseConfig();
  const headers = createSupabaseHeaders();
  const params = new URLSearchParams({
    select: 'id,name,city',
    id: `eq.${propertyId}`,
    active: 'eq.true',
  });
  const res = await fetch(`${url}/rest/v1/properties?${params.toString()}`, { headers });
  if (!res.ok) {
    const details = await readErrorText(res);
    throw new Error(details || `Supabase devolvio ${res.status} al leer properties`);
  }
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function listBookingListings() {
  const { url } = getSupabaseConfig();
  const headers = createSupabaseHeaders();
  const params = new URLSearchParams({
    select: 'id,property_id,display_name,listing_url,external_listing_id,metadata',
    connector: 'eq.booking',
    active: 'eq.true',
    order: 'created_at.desc',
    limit: '500',
  });
  const res = await fetch(`${url}/rest/v1/external_listings?${params.toString()}`, { headers });
  if (!res.ok) {
    const details = await readErrorText(res);
    throw new Error(details || `Supabase devolvio ${res.status} al leer external_listings de Booking`);
  }
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

async function listBookingImportBatchesOverview() {
  const { url } = getSupabaseConfig();
  const headers = createSupabaseHeaders();
  const params = new URLSearchParams({
    select:
      'id,property_id,source_filename,rows_detected,rows_new,rows_duplicate_existing,rows_duplicate_in_file,rows_invalid,rows_translated,review_date_from,review_date_to,status,created_at',
    order: 'created_at.desc',
    limit: '5000',
  });
  const res = await fetch(`${url}/rest/v1/booking_import_batches?${params.toString()}`, { headers });
  if (!res.ok) {
    const details = await readErrorText(res);
    if (isMissingBookingTableError(details)) {
      return {
        rows: [],
        setupRequired: true,
        setupMessage: bookingSetupMessage(
          'mostrar el historial operativo de Booking',
          detectMissingBookingTableName(details) || 'booking_import_batches'
        ),
      };
    }
    throw new Error(details || `Supabase devolvio ${res.status} al leer booking_import_batches`);
  }
  const rows = await res.json();
  return {
    rows: Array.isArray(rows) ? rows : [],
    setupRequired: false,
    setupMessage: '',
  };
}

function buildBookingOverview(properties = [], listings = [], importBatches = []) {
  const listingMap = new Map();
  listings.forEach((listing) => {
    const propertyId = normalizeText(listing?.property_id);
    if (!propertyId || listingMap.has(propertyId)) return;
    listingMap.set(propertyId, listing);
  });

  const batchesMap = new Map();
  importBatches.forEach((batch) => {
    const propertyId = normalizeText(batch?.property_id);
    if (!propertyId) return;
    if (!batchesMap.has(propertyId)) batchesMap.set(propertyId, []);
    batchesMap.get(propertyId).push(batch);
  });

  return properties.map((property) => {
    const propertyId = normalizeText(property?.id);
    const listing = listingMap.get(propertyId) || null;
    const batches = (batchesMap.get(propertyId) || []).slice().sort((left, right) =>
      String(right?.created_at || '').localeCompare(String(left?.created_at || ''))
    );
    const lastBatch = batches[0] || null;
    const totalRowsImported = batches.reduce(
      (sum, batch) => sum + (Number(batch?.rows_new) || 0),
      0
    );
    const bookingUrl =
      normalizeText(listing?.listing_url) ||
      normalizeText(listing?.metadata?.bookingReviewUrl) ||
      fallbackBookingReviewUrl(property);

    return {
      propertyId,
      name: property?.name || '',
      city: property?.city || '',
      bookingUrl,
      listingLabel:
        normalizeText(listing?.display_name) ||
        normalizeText(listing?.external_listing_id) ||
        (bookingUrl ? 'Booking reviews' : '') ||
        '',
      totalUploads: batches.length,
      totalRowsImported,
      lastImportAt: lastBatch?.created_at || null,
      lastFileName: lastBatch?.source_filename || null,
      lastRowsDetected: Number(lastBatch?.rows_detected) || 0,
      lastRowsNew: Number(lastBatch?.rows_new) || 0,
      lastRowsInvalid: Number(lastBatch?.rows_invalid) || 0,
      lastRowsDuplicates:
        (Number(lastBatch?.rows_duplicate_existing) || 0) +
        (Number(lastBatch?.rows_duplicate_in_file) || 0),
      lastReviewDateFrom: lastBatch?.review_date_from || null,
      lastReviewDateTo: lastBatch?.review_date_to || null,
      lastStatus: normalizeText(lastBatch?.status) || '',
    };
  });
}

async function listExistingBookingKeys(propertyId, bookingKeys = [], externalIds = []) {
  const { url } = getSupabaseConfig();
  const headers = createSupabaseHeaders();
  const existingKeys = new Set();
  const existingExternalIds = new Set();

  const reviewsRes = await fetch(
    `${url}/rest/v1/reviews?${new URLSearchParams({
      select: 'external_review_id',
      connector: `eq.${BOOKING_CONNECTOR}`,
      property_id: `eq.${propertyId}`,
      limit: '5000',
    }).toString()}`,
    { headers }
  );

  if (!reviewsRes.ok) {
    const details = await readErrorText(reviewsRes);
    throw new Error(details || 'No se pudo revisar duplicados de Booking');
  }

  const reviewRows = await reviewsRes.json();
  const externalIdFilter = new Set(externalIds);

  (Array.isArray(reviewRows) ? reviewRows : []).forEach((row) => {
    if (row?.external_review_id && externalIdFilter.has(row.external_review_id)) {
      existingExternalIds.add(row.external_review_id);
    }
  });

  return { existingKeys, existingExternalIds };
}

function parseBookingCsv({ propertyId, filename, csvBase64 }) {
  const decodedText = decodeCsvBase64(csvBase64);
  const rows = parseCsvRows(decodedText);
  if (!rows.length) throw new Error('El archivo CSV esta vacio');

  const headerRow = rows[0].map((cell) => cleanTextField(cell) || '');
  const headerMap = buildHeaderMap(headerRow);
  const missingHeaders = listMissingHeaders(headerMap);
  if (missingHeaders.length) {
    throw new Error(`Faltan columnas obligatorias de Booking: ${missingHeaders.join(', ')}`);
  }

  const parsedRows = [];
  for (let index = 1; index < rows.length; index += 1) {
    const cells = rows[index];
    if (!cells || cells.every((cell) => !normalizeText(cell))) continue;

    const reviewDateRaw = cleanTextField(getCell(cells, headerMap, 'review_date'));
    const guestName = cleanTextField(getCell(cells, headerMap, 'guest_name'));
    const reservationNumber = cleanTextField(getCell(cells, headerMap, 'reservation_number'));
    const reviewTitle = cleanTextField(getCell(cells, headerMap, 'review_title'));
    const positiveReview = cleanTextField(getCell(cells, headerMap, 'positive_review'));
    const negativeReview = cleanTextField(getCell(cells, headerMap, 'negative_review'));
    const propertyReply = cleanTextField(getCell(cells, headerMap, 'property_reply'));
    const reviewDateIso = parseReviewDate(reviewDateRaw);
    const ratingOverall10 = parseNumericScore(getCell(cells, headerMap, 'review_score'));
    const scoreStaff = parseNumericScore(getCell(cells, headerMap, 'staff'));
    const scoreCleanliness = parseNumericScore(getCell(cells, headerMap, 'cleanliness'));
    const scoreLocation = parseNumericScore(getCell(cells, headerMap, 'location'));
    const scoreFacilities = parseNumericScore(getCell(cells, headerMap, 'facilities'));
    const scoreComfort = parseNumericScore(getCell(cells, headerMap, 'comfort'));
    const scoreValueForMoney = parseNumericScore(getCell(cells, headerMap, 'value_for_money'));

    const issues = [];
    if (!reviewDateIso) issues.push('review_date_invalida');
    if (!guestName) issues.push('guest_name_vacio');
    if (!reservationNumber) issues.push('reservation_number_vacio');
    if (!Number.isFinite(ratingOverall10)) issues.push('review_score_invalido');
    if (!issues.length && !isBookingReviewInScope(reviewDateIso)) {
      issues.push('review_date_fuera_de_rango');
    }

    const bookingReviewKey =
      reviewDateIso && guestName && reservationNumber
        ? buildBookingReviewKey({
            propertyId,
            reviewDateIso,
            guestName,
            reservationNumber,
          })
        : null;
    const externalReviewId = bookingReviewKey ? buildExternalReviewId(bookingReviewKey) : null;

    const row = {
      rowNumber: index + 1,
      sourceFilename: filename || null,
      reviewDateRaw,
      reviewDateIso,
      guestName,
      reservationNumber,
      reviewTitle,
      positiveReview,
      negativeReview,
      propertyReply,
      ratingOverall10,
      ratingGeneral5: scoreToGeneralRating(ratingOverall10),
      scoreStaff,
      scoreCleanliness,
      scoreLocation,
      scoreFacilities,
      scoreComfort,
      scoreValueForMoney,
      bookingReviewKey,
      externalReviewId,
      combinedComment: buildCombinedComment({ reviewTitle, positiveReview, negativeReview }),
      scoreAverage10: null,
      issues,
      status: issues.includes('review_date_fuera_de_rango')
        ? 'out_of_scope'
        : issues.length
          ? 'invalid'
          : 'parsed',
      rawCsv: {
        review_date: getCell(cells, headerMap, 'review_date'),
        guest_name: getCell(cells, headerMap, 'guest_name'),
        reservation_number: getCell(cells, headerMap, 'reservation_number'),
        review_title: getCell(cells, headerMap, 'review_title'),
        positive_review: getCell(cells, headerMap, 'positive_review'),
        negative_review: getCell(cells, headerMap, 'negative_review'),
        review_score: getCell(cells, headerMap, 'review_score'),
        staff: getCell(cells, headerMap, 'staff'),
        cleanliness: getCell(cells, headerMap, 'cleanliness'),
        location: getCell(cells, headerMap, 'location'),
        facilities: getCell(cells, headerMap, 'facilities'),
        comfort: getCell(cells, headerMap, 'comfort'),
        value_for_money: getCell(cells, headerMap, 'value_for_money'),
        property_reply: getCell(cells, headerMap, 'property_reply'),
      },
    };

    row.rating_overall_10 = row.ratingOverall10;
    row.score_staff = row.scoreStaff;
    row.score_cleanliness = row.scoreCleanliness;
    row.score_location = row.scoreLocation;
    row.score_facilities = row.scoreFacilities;
    row.score_comfort = row.scoreComfort;
    row.score_value_for_money = row.scoreValueForMoney;
    row.scoreAverage10 = buildAverageScore(row);

    parsedRows.push(row);
  }

  const seenKeys = new Set();
  parsedRows.forEach((row) => {
    if (row.status !== 'parsed' || !row.bookingReviewKey) return;
    if (seenKeys.has(row.bookingReviewKey)) {
      row.status = 'duplicate_in_file';
      row.issues.push('duplicada_en_archivo');
      return;
    }
    seenKeys.add(row.bookingReviewKey);
  });

  return {
    decodedText,
    headerRow,
    parsedRows,
  };
}

async function buildPreview({ propertyId, filename, csvBase64 }) {
  const property = await getPropertyById(propertyId);
  if (!property) throw new Error('Propiedad invalida o inactiva');

  const { parsedRows } = parseBookingCsv({ propertyId, filename, csvBase64 });
  const validRows = parsedRows.filter((row) => row.status === 'parsed');
  const { existingKeys, existingExternalIds } = await listExistingBookingKeys(
    propertyId,
    validRows.map((row) => row.bookingReviewKey),
    validRows.map((row) => row.externalReviewId)
  );

  parsedRows.forEach((row) => {
    if (row.status !== 'parsed') return;
    if (
      existingKeys.has(row.bookingReviewKey) ||
      existingExternalIds.has(row.externalReviewId)
    ) {
      row.status = 'duplicate_existing';
      row.issues.push('duplicada_en_sistema');
    }
  });

  const summary = {
    property,
    filename: filename || 'booking.csv',
    rowsTotal: parsedRows.length,
    rowsValid: parsedRows.filter((row) => row.status === 'parsed').length,
    rowsNew: parsedRows.filter((row) => row.status === 'parsed').length,
    rowsDuplicateExisting: parsedRows.filter((row) => row.status === 'duplicate_existing').length,
    rowsDuplicateInFile: parsedRows.filter((row) => row.status === 'duplicate_in_file').length,
    rowsOutOfScope: parsedRows.filter((row) => row.status === 'out_of_scope').length,
    rowsInvalid: parsedRows.filter((row) => row.status === 'invalid').length,
    monthsDetected: [...new Set(validRows.map((row) => monthKeyFromIso(row.reviewDateIso)).filter(Boolean))].sort(),
    translationConfigured: Boolean(process.env.GOOGLE_TRANSLATE_API_KEY),
    minReviewYear: BOOKING_MIN_REVIEW_YEAR,
  };

  return {
    summary,
    sampleRows: sortPreviewRows(parsedRows).slice(0, 10).map((row) => ({
      rowNumber: row.rowNumber,
      status: row.status,
      issues: row.issues,
      reviewDateIso: row.reviewDateIso,
      guestName: row.guestName,
      reservationNumber: row.reservationNumber,
      ratingOverall10: row.ratingOverall10,
      ratingGeneral5: row.ratingGeneral5,
      positiveReview: row.positiveReview,
      negativeReview: row.negativeReview,
      combinedComment: row.combinedComment,
    })),
  };
}

async function translateTexts(texts = []) {
  const apiKey = normalizeText(process.env.GOOGLE_TRANSLATE_API_KEY);
  if (!texts.length || !apiKey) return { translations: [], configured: Boolean(apiKey) };

  const translations = [];
  for (const batch of chunk(texts, MAX_TRANSLATE_BATCH_SIZE)) {
    const response = await fetch(`${GOOGLE_TRANSLATE_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: batch.map((item) => item.text),
        target: 'es',
        format: 'text',
      }),
    });

    if (!response.ok) {
      const details = await readErrorText(response);
      throw new Error(details || `Google Translate devolvio ${response.status}`);
    }

    const payload = await response.json();
    const items = Array.isArray(payload?.data?.translations) ? payload.data.translations : [];
    items.forEach((translation, index) => {
      translations.push({
        ...batch[index],
        translatedText: cleanTextField(translation?.translatedText || batch[index].text) || batch[index].text,
        detectedSourceLanguage: normalizeText(translation?.detectedSourceLanguage).toLowerCase() || null,
      });
    });
  }

  return { translations, configured: true };
}

async function enrichRowsWithTranslations(rows = []) {
  const textTasks = [];
  rows.forEach((row, rowIndex) => {
    [
      ['reviewTitle', row.reviewTitle],
      ['positiveReview', row.positiveReview],
      ['negativeReview', row.negativeReview],
      ['propertyReply', row.propertyReply],
    ].forEach(([field, value]) => {
      if (!value) return;
      textTasks.push({ rowIndex, field, text: value });
    });
  });

  if (!textTasks.length) {
    return {
      translationConfigured: Boolean(process.env.GOOGLE_TRANSLATE_API_KEY),
      translatedRows: 0,
      rows,
    };
  }

  let translatedRows = 0;
  let translationConfigured = Boolean(process.env.GOOGLE_TRANSLATE_API_KEY);

  try {
    const result = await translateTexts(textTasks);
    translationConfigured = result.configured;
    const translatedByRow = new Map();

    result.translations.forEach((item) => {
      if (!translatedByRow.has(item.rowIndex)) translatedByRow.set(item.rowIndex, []);
      translatedByRow.get(item.rowIndex).push(item);
    });

    rows.forEach((row, rowIndex) => {
      const translations = translatedByRow.get(rowIndex) || [];
      const languageHits = [];
      translations.forEach((item) => {
        const translatedKey = `translated${item.field[0].toUpperCase()}${item.field.slice(1)}`;
        row[translatedKey] = item.translatedText || row[item.field];
        if (item.detectedSourceLanguage) languageHits.push(item.detectedSourceLanguage);
      });

      if (!translations.length) {
        row.translationStatus = 'not_needed';
      } else if (languageHits.some((code) => code && code !== 'es')) {
        row.translationStatus = 'translated';
        translatedRows += 1;
      } else {
        row.translationStatus = 'not_needed';
      }

      row.sourceLanguage = languageHits.find(Boolean) || 'es';
      row.translationProvider = translationConfigured ? 'google_translate_basic_v2' : null;
      row.translatedCombinedComment = buildCombinedComment({
        reviewTitle: row.translatedReviewTitle || row.reviewTitle,
        positiveReview: row.translatedPositiveReview || row.positiveReview,
        negativeReview: row.translatedNegativeReview || row.negativeReview,
      });
    });
  } catch (error) {
    rows.forEach((row) => {
      row.translationStatus = translationConfigured ? 'error' : 'not_configured';
      row.translatedCombinedComment = row.combinedComment;
    });
  }

  rows.forEach((row) => {
    if (!row.translationStatus) row.translationStatus = translationConfigured ? 'not_needed' : 'not_configured';
    if (!row.translatedCombinedComment) row.translatedCombinedComment = row.combinedComment;
  });

  return {
    translationConfigured,
    translatedRows,
    rows,
  };
}

async function createImportBatch(batch) {
  const { url } = getSupabaseConfig();
  const res = await fetch(`${url}/rest/v1/booking_import_batches`, {
    method: 'POST',
    headers: createSupabaseHeaders({
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    }),
    body: JSON.stringify(batch),
  });
  if (!res.ok) {
    const details = await readErrorText(res);
    throw new Error(details || `Supabase devolvio ${res.status} al crear booking_import_batch`);
  }
}

async function patchImportBatch(batchId, payload) {
  const { url } = getSupabaseConfig();
  const res = await fetch(`${url}/rest/v1/booking_import_batches?id=eq.${encodeURIComponent(batchId)}`, {
    method: 'PATCH',
    headers: createSupabaseHeaders({
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    }),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const details = await readErrorText(res);
    throw new Error(details || `Supabase devolvio ${res.status} al actualizar booking_import_batch`);
  }
}

async function insertReviews(rows) {
  if (!rows.length) return;
  const { url } = getSupabaseConfig();
  const res = await fetch(`${url}/rest/v1/reviews`, {
    method: 'POST',
    headers: createSupabaseHeaders({
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const details = await readErrorText(res);
    throw new Error(details || `Supabase devolvio ${res.status} al crear reviews booking`);
  }
}

async function insertBookingReviewDetails(rows) {
  if (!rows.length) return;
  const { url } = getSupabaseConfig();
  const res = await fetch(`${url}/rest/v1/booking_review_details`, {
    method: 'POST',
    headers: createSupabaseHeaders({
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const details = await readErrorText(res);
    throw new Error(details || `Supabase devolvio ${res.status} al crear booking_review_details`);
  }
}

async function deleteReviewsByIds(ids = []) {
  if (!ids.length) return;
  const { url } = getSupabaseConfig();
  const res = await fetch(
    `${url}/rest/v1/reviews?id=in.(${ids.map((value) => encodeURIComponent(value)).join(',')})`,
    {
      method: 'DELETE',
      headers: createSupabaseHeaders({
        Prefer: 'return=minimal',
      }),
    }
  );
  if (!res.ok) {
    const details = await readErrorText(res);
    throw new Error(details || `Supabase devolvio ${res.status} al revertir reviews booking`);
  }
}

async function deleteImportBatch(batchId) {
  const { url } = getSupabaseConfig();
  const res = await fetch(`${url}/rest/v1/booking_import_batches?id=eq.${encodeURIComponent(batchId)}`, {
    method: 'DELETE',
    headers: createSupabaseHeaders({
      Prefer: 'return=minimal',
    }),
  });
  if (!res.ok) {
    const details = await readErrorText(res);
    throw new Error(details || `Supabase devolvio ${res.status} al revertir booking_import_batch`);
  }
}

async function importBookingCsv({ propertyId, filename, csvBase64, uploadedBy }) {
  const property = await getPropertyById(propertyId);
  if (!property) throw new Error('Propiedad invalida o inactiva');

  const { parsedRows } = parseBookingCsv({ propertyId, filename, csvBase64 });
  const validRows = parsedRows.filter((row) => row.status === 'parsed');
  const { existingKeys, existingExternalIds } = await listExistingBookingKeys(
    propertyId,
    validRows.map((row) => row.bookingReviewKey),
    validRows.map((row) => row.externalReviewId)
  );

  parsedRows.forEach((row) => {
    if (row.status !== 'parsed') return;
    if (
      existingKeys.has(row.bookingReviewKey) ||
      existingExternalIds.has(row.externalReviewId)
    ) {
      row.status = 'duplicate_existing';
      row.issues.push('duplicada_en_sistema');
    }
  });

  const rowsToInsert = parsedRows.filter((row) => row.status === 'parsed');
  const translationResult = await enrichRowsWithTranslations(rowsToInsert);
  const importBatchId = crypto.randomUUID();
  const reviewIds = rowsToInsert.map(() => crypto.randomUUID());

  const reviewDateValues = rowsToInsert
    .map((row) => row.reviewDateIso)
    .filter(Boolean)
    .sort();

  try {
    await createImportBatch({
      id: importBatchId,
      property_id: propertyId,
      source_filename: filename || 'booking.csv',
      uploaded_by: normalizeText(uploadedBy) || null,
    rows_detected: parsedRows.length,
    rows_new: rowsToInsert.length,
    rows_duplicate_existing: parsedRows.filter((row) => row.status === 'duplicate_existing').length,
    rows_duplicate_in_file: parsedRows.filter((row) => row.status === 'duplicate_in_file').length,
    rows_invalid: parsedRows.filter((row) => row.status === 'invalid').length,
      rows_translated: translationResult.translatedRows,
      review_date_from: reviewDateValues[0] || null,
      review_date_to: reviewDateValues[reviewDateValues.length - 1] || null,
      status: 'processing',
      metadata: {
        translationConfigured: translationResult.translationConfigured,
        rowsOutOfScope: parsedRows.filter((row) => row.status === 'out_of_scope').length,
      },
    });
  } catch (error) {
    throw toBookingSetupError(error, 'importar reviews de Booking');
  }

  const reviewRows = rowsToInsert.map((row, index) => ({
    id: reviewIds[index],
    property_id: propertyId,
    guest_name: row.guestName,
    room_name: null,
    rating: row.ratingGeneral5,
    comment: row.translatedCombinedComment || row.combinedComment,
    would_return: null,
    source: 'booking_csv',
    connector: BOOKING_CONNECTOR,
    channel: BOOKING_CHANNEL,
    source_type: BOOKING_SOURCE_TYPE,
    external_review_id: row.externalReviewId,
    reviewed_at: row.reviewDateIso,
    is_public: true,
    response_status: 'not_applicable',
    raw_payload: {
      connector: BOOKING_CONNECTOR,
      booking: {
        reviewTitle: row.reviewTitle,
        positiveReview: row.positiveReview,
        negativeReview: row.negativeReview,
        propertyReply: row.propertyReply,
        reviewDateRaw: row.reviewDateRaw,
        sourceFilename: filename || 'booking.csv',
      },
    },
    metadata: {
      connector: BOOKING_CONNECTOR,
      booking: {
        bookingReviewKey: row.bookingReviewKey,
        ratingOverall10: row.ratingOverall10,
        scoreAverage10: row.scoreAverage10,
        translationStatus: row.translationStatus,
      },
    },
  }));

  const detailRows = rowsToInsert.map((row, index) => ({
    id: crypto.randomUUID(),
    review_id: reviewIds[index],
    import_batch_id: importBatchId,
    property_id: propertyId,
    booking_review_key: row.bookingReviewKey,
    source_filename: filename || 'booking.csv',
    review_date: row.reviewDateIso,
    guest_name: row.guestName,
    reservation_number: row.reservationNumber,
    review_title: row.reviewTitle,
    positive_review: row.positiveReview,
    negative_review: row.negativeReview,
    property_reply: row.propertyReply,
    combined_comment: row.combinedComment,
    translated_title: row.translatedReviewTitle || null,
    translated_positive_review: row.translatedPositiveReview || null,
    translated_negative_review: row.translatedNegativeReview || null,
    translated_property_reply: row.translatedPropertyReply || null,
    translated_combined_comment: row.translatedCombinedComment || row.combinedComment,
    source_language: row.sourceLanguage || null,
    translation_provider: row.translationProvider || null,
    translation_status: row.translationStatus || 'not_needed',
    rating_overall_10: row.ratingOverall10,
    rating_general_5: row.ratingGeneral5,
    score_staff: row.scoreStaff,
    score_cleanliness: row.scoreCleanliness,
    score_location: row.scoreLocation,
    score_facilities: row.scoreFacilities,
    score_comfort: row.scoreComfort,
    score_value_for_money: row.scoreValueForMoney,
    score_average_10: row.scoreAverage10,
    raw_csv: row.rawCsv,
    metadata: {
      issues: row.issues,
    },
  }));

  try {
    await insertReviews(reviewRows);
    await insertBookingReviewDetails(detailRows);
    await patchImportBatch(importBatchId, {
      status: 'completed',
      metadata: {
        translationConfigured: translationResult.translationConfigured,
        sampleMonths: [...new Set(rowsToInsert.map((row) => monthKeyFromIso(row.reviewDateIso)).filter(Boolean))].sort(),
      },
    });
  } catch (error) {
    try {
      await deleteReviewsByIds(reviewIds);
    } catch (cleanupError) {
      console.error('[booking-import] cleanup reviews error', cleanupError.message);
    }
    try {
      await deleteImportBatch(importBatchId);
    } catch (cleanupError) {
      console.error('[booking-import] cleanup batch error', cleanupError.message);
    }
    throw toBookingSetupError(error, 'importar reviews de Booking');
  }

  return {
    property,
    summary: {
      filename: filename || 'booking.csv',
      rowsTotal: parsedRows.length,
      rowsImported: rowsToInsert.length,
      rowsDuplicateExisting: parsedRows.filter((row) => row.status === 'duplicate_existing').length,
      rowsDuplicateInFile: parsedRows.filter((row) => row.status === 'duplicate_in_file').length,
      rowsOutOfScope: parsedRows.filter((row) => row.status === 'out_of_scope').length,
      rowsInvalid: parsedRows.filter((row) => row.status === 'invalid').length,
      rowsTranslated: translationResult.translatedRows,
      importBatchId,
      translationConfigured: translationResult.translationConfigured,
    },
  };
}

function average(values = []) {
  const numeric = values.filter((value) => Number.isFinite(value));
  if (!numeric.length) return null;
  return Number((numeric.reduce((sum, value) => sum + value, 0) / numeric.length).toFixed(2));
}

function aggregateBookingRows(rows = []) {
  const avgOverall10 = average(rows.map((row) => Number(row.rating_overall_10)));
  const summary = {
    totalReviews: rows.length,
    avgOverall10,
    avgGeneral5: scoreToDisplayRating5(avgOverall10),
    avgScoreAverage10: average(rows.map((row) => Number(row.score_average_10))),
    translatedReviews: rows.filter((row) => row.translation_status === 'translated').length,
  };

  const monthlyMap = new Map();
  rows.forEach((row) => {
    const key = monthKeyFromIso(row.review_date);
    if (!key) return;
    if (!monthlyMap.has(key)) monthlyMap.set(key, []);
    monthlyMap.get(key).push(row);
  });

  const monthly = [...monthlyMap.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([month, items]) => ({
      month,
      count: items.length,
      avgOverall10: average(items.map((item) => Number(item.rating_overall_10))),
      avgGeneral5: scoreToDisplayRating5(
        average(items.map((item) => Number(item.rating_overall_10)))
      ),
      avgStaff: average(items.map((item) => Number(item.score_staff))),
      avgCleanliness: average(items.map((item) => Number(item.score_cleanliness))),
      avgLocation: average(items.map((item) => Number(item.score_location))),
      avgFacilities: average(items.map((item) => Number(item.score_facilities))),
      avgComfort: average(items.map((item) => Number(item.score_comfort))),
      avgValueForMoney: average(items.map((item) => Number(item.score_value_for_money))),
    }));

  const areaSummary = AREA_DETAILS.map((area) => {
    const distribution = new Map();
    rows.forEach((row) => {
      const score = row[area.key];
      if (!Number.isFinite(Number(score))) return;
      const key = String(Number(score));
      distribution.set(key, (distribution.get(key) || 0) + 1);
    });

    return {
      key: area.key,
      label: area.label,
      average: average(rows.map((row) => Number(row[area.key]))),
      distribution: [...distribution.entries()]
        .sort((left, right) => Number(left[0]) - Number(right[0]))
        .map(([score, count]) => ({ score: Number(score), count })),
    };
  });

  const strongestArea = areaSummary
    .filter((area) => area.key !== 'rating_overall_10' && area.average !== null)
    .sort((left, right) => right.average - left.average)[0] || null;
  const weakestArea = areaSummary
    .filter((area) => area.key !== 'rating_overall_10' && area.average !== null)
    .sort((left, right) => left.average - right.average)[0] || null;

  return {
    summary: {
      ...summary,
      strongestArea,
      weakestArea,
    },
    monthly,
    areaSummary,
  };
}

async function loadBookingDashboard({ propertyId, year, month }) {
  const [properties, listings, importOverview] = await Promise.all([
    listActiveProperties(),
    listBookingListings(),
    listBookingImportBatchesOverview(),
  ]);
  const overview = buildBookingOverview(properties, listings, importOverview.rows);
  const emptyAnalytics = aggregateBookingRows([]);
  const selectedOverview =
    overview.find((item) => item.propertyId === normalizeText(propertyId)) || null;

  if (!propertyId) {
    return {
      overview,
      overviewSetupRequired: importOverview.setupRequired,
      overviewSetupMessage: importOverview.setupMessage,
      selectedPropertyId: '',
      selectedProperty: null,
      filters: {
        availableYears: [],
        selectedYear: year || '',
        selectedMonth: month || '',
      },
      summary: emptyAnalytics.summary,
      monthly: emptyAnalytics.monthly,
      areaSummary: [],
      recentReviews: [],
      importBatches: [],
      setupRequired: false,
      setupMessage: '',
    };
  }

  const property = await getPropertyById(propertyId);
  if (!property) throw new Error('Propiedad invalida o inactiva');

  const { url } = getSupabaseConfig();
  const headers = createSupabaseHeaders();
  const reviewParams = new URLSearchParams({
    select:
      'id,review_id,property_id,source_filename,review_date,guest_name,reservation_number,review_title,positive_review,negative_review,combined_comment,translated_combined_comment,translation_status,source_language,rating_overall_10,rating_general_5,score_staff,score_cleanliness,score_location,score_facilities,score_comfort,score_value_for_money,score_average_10',
    property_id: `eq.${propertyId}`,
    order: 'review_date.desc',
    limit: '5000',
  });
  const batchParams = new URLSearchParams({
    select:
      'id,source_filename,uploaded_by,rows_detected,rows_new,rows_duplicate_existing,rows_duplicate_in_file,rows_invalid,rows_translated,review_date_from,review_date_to,status,created_at',
    property_id: `eq.${propertyId}`,
    order: 'created_at.desc',
    limit: '12',
  });

  const [reviewsRes, batchesRes] = await Promise.all([
    fetch(`${url}/rest/v1/booking_review_details?${reviewParams.toString()}`, { headers }),
    fetch(`${url}/rest/v1/booking_import_batches?${batchParams.toString()}`, { headers }),
  ]);

  if (!reviewsRes.ok || !batchesRes.ok) {
    const details = [
      !reviewsRes.ok ? await readErrorText(reviewsRes) : '',
      !batchesRes.ok ? await readErrorText(batchesRes) : '',
    ]
      .filter(Boolean)
      .join(' | ');
    if (isMissingBookingTableError(details)) {
      return {
        overview,
        overviewSetupRequired: importOverview.setupRequired,
        overviewSetupMessage: importOverview.setupMessage,
        selectedPropertyId: propertyId,
        selectedProperty: selectedOverview || {
          propertyId: property.id,
          name: property.name,
          city: property.city,
          bookingUrl: '',
          listingLabel: '',
          totalUploads: 0,
          totalRowsImported: 0,
          lastImportAt: null,
          lastFileName: null,
          lastRowsDetected: 0,
          lastRowsNew: 0,
          lastRowsInvalid: 0,
          lastRowsDuplicates: 0,
          lastReviewDateFrom: null,
          lastReviewDateTo: null,
          lastStatus: '',
        },
        property,
        setupRequired: true,
        setupMessage: bookingSetupMessage(
          'mostrar analytics de Booking',
          detectMissingBookingTableName(details) || 'booking_review_details'
        ),
        filters: {
          availableYears: [],
          selectedYear: year || '',
          selectedMonth: month || '',
        },
        summary: emptyAnalytics.summary,
        monthly: emptyAnalytics.monthly,
        areaSummary: [],
        recentReviews: [],
        importBatches: [],
      };
    }
    throw new Error(details || 'No se pudo cargar el dashboard de Booking');
  }

  const reviewRows = await reviewsRes.json();
  const importBatches = await batchesRes.json();

  const scopedRows = reviewRows.filter((row) => isBookingReviewInScope(row.review_date));
  const availableYears = [...new Set(scopedRows.map((row) => String(row.review_date || '').slice(0, 4)).filter(Boolean))].sort();
  const filteredRows = scopedRows.filter((row) => {
    const iso = String(row.review_date || '');
    if (year && iso.slice(0, 4) !== String(year)) return false;
    if (month && iso.slice(5, 7) !== String(month).padStart(2, '0')) return false;
    return true;
  });

  const analytics = aggregateBookingRows(filteredRows);
  return {
    overview,
    overviewSetupRequired: importOverview.setupRequired,
    overviewSetupMessage: importOverview.setupMessage,
    selectedPropertyId: propertyId,
    selectedProperty:
      selectedOverview || {
        propertyId: property.id,
        name: property.name,
        city: property.city,
        bookingUrl: '',
        listingLabel: '',
        totalUploads: 0,
        totalRowsImported: 0,
        lastImportAt: null,
        lastFileName: null,
        lastRowsDetected: 0,
        lastRowsNew: 0,
        lastRowsInvalid: 0,
        lastRowsDuplicates: 0,
        lastReviewDateFrom: null,
        lastReviewDateTo: null,
        lastStatus: '',
      },
    property,
    filters: {
      availableYears,
      selectedYear: year || '',
      selectedMonth: month || '',
    },
    summary: analytics.summary,
    monthly: analytics.monthly,
    areaSummary: analytics.areaSummary,
    recentReviews: filteredRows.slice(0, 25),
    importBatches: Array.isArray(importBatches) ? importBatches : [],
    setupRequired: false,
    setupMessage: '',
  };
}

module.exports = {
  AREA_DETAILS,
  BOOKING_CHANNEL,
  BOOKING_CONNECTOR,
  BOOKING_SOURCE_TYPE,
  buildPreview,
  importBookingCsv,
  loadBookingDashboard,
  parseBookingCsv,
  scoreToGeneralRating,
};
