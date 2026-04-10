const {
  createSupabaseHeaders,
  getSupabaseConfig,
  json,
  readErrorText,
  requireSession,
  unauthorized,
} = require('./_dashboard');

const DEFAULT_CLOUDBEDS_API_BASE_URL = 'https://api.cloudbeds.com/api/v1.3';
const DEFAULT_SYNC_WINDOW_DAYS = 14;
const DEFAULT_BATCH_SIZE = 200;

function getHeader(headers = {}, name) {
  const lowered = name.toLowerCase();
  const direct = headers[name];
  if (direct !== undefined) return direct;
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === lowered) return value;
  }
  return undefined;
}

function parseCommaSeparated(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
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

function ensureArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

function pick(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function parseCloudbedsData(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.reservations)) return payload.data.reservations;
  if (Array.isArray(payload?.data?.hotels)) return payload.data.hotels;
  if (Array.isArray(payload?.result)) return payload.result;
  if (Array.isArray(payload?.reservations)) return payload.reservations;
  if (Array.isArray(payload?.hotels)) return payload.hotels;
  return [];
}

function parseCloudbedsObject(payload) {
  if (!payload || typeof payload !== 'object') return {};
  if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
    return payload.data;
  }
  if (payload.result && typeof payload.result === 'object' && !Array.isArray(payload.result)) {
    return payload.result;
  }
  return payload;
}

function toIsoDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function toIsoDateTime(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function subtractDays(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function getCloudbedsConfig() {
  const apiKey = normalizeText(process.env.CLOUDBEDS_API_KEY);
  if (!apiKey) {
    throw new Error('Falta CLOUDBEDS_API_KEY en el entorno');
  }
  return {
    apiKey,
    baseUrl: normalizeText(process.env.CLOUDBEDS_API_BASE_URL) || DEFAULT_CLOUDBEDS_API_BASE_URL,
    configuredPropertyIds: parseCommaSeparated(process.env.CLOUDBEDS_PROPERTY_IDS),
    sourceAccountId: normalizeText(process.env.CLOUDBEDS_SOURCE_ACCOUNT_ID) || null,
    groupAccountId: normalizeText(process.env.CLOUDBEDS_GROUP_ACCOUNT_ID) || null,
    defaultSyncWindowDays: Math.max(
      1,
      Number.parseInt(process.env.CLOUDBEDS_DEFAULT_SYNC_WINDOW_DAYS || '', 10) ||
        DEFAULT_SYNC_WINDOW_DAYS
    ),
    syncSecret: normalizeText(process.env.CLOUDBEDS_SYNC_SECRET) || null,
  };
}

async function requireSyncAccess(event) {
  const syncSecret = normalizeText(process.env.CLOUDBEDS_SYNC_SECRET) || null;
  const secretHeader =
    getHeader(event.headers, 'x-sync-secret') ||
    getHeader(event.headers, 'x-cloudbeds-sync-secret');

  if (syncSecret && secretHeader === syncSecret) {
    return { ok: true, mode: 'secret' };
  }

  const { error, session } = requireSession(event);
  if (!error && session) {
    return { ok: true, mode: 'session', session };
  }

  if (syncSecret) {
    return {
      ok: false,
      error: unauthorized('Secret o sesión requerida para ejecutar cloudbeds-sync'),
    };
  }

  return {
    ok: false,
    error: unauthorized(
      'Sesion requerida. Opcionalmente define CLOUDBEDS_SYNC_SECRET para cron o llamadas internas'
    ),
  };
}

async function cloudbedsGet(method, query = {}) {
  const { apiKey, baseUrl } = getCloudbedsConfig();
  const url = new URL(`${baseUrl.replace(/\/$/, '')}/${method}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && !value.length) continue;
    url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }

  const response = await fetch(url, {
    headers: {
      'x-api-key': apiKey,
      Accept: 'application/json',
    },
  });

  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      payload = { raw: text };
    }
  }

  if (!response.ok) {
    const message =
      payload?.message ||
      payload?.error ||
      payload?.raw ||
      `Cloudbeds devolvio ${response.status} en ${method}`;
    const err = new Error(message);
    err.status = response.status;
    err.payload = payload;
    throw err;
  }

  return payload;
}

async function listSupabaseCloudbedsMappings() {
  const { url } = getSupabaseConfig();
  const headers = createSupabaseHeaders();

  const [listingsRes, accountsRes, propertiesRes] = await Promise.all([
    fetch(
      `${url}/rest/v1/external_listings?select=id,property_id,source_account_id,external_listing_id,external_property_id,display_name,metadata&connector=eq.cloudbeds&active=eq.true`,
      { headers }
    ),
    fetch(
      `${url}/rest/v1/source_accounts?select=id,connector,label,external_account_id&connector=eq.cloudbeds&active=eq.true`,
      { headers }
    ),
    fetch(`${url}/rest/v1/properties?select=id,name,city&active=eq.true`, { headers }),
  ]);

  if (!listingsRes.ok || !accountsRes.ok || !propertiesRes.ok) {
    const details = [
      !listingsRes.ok ? await readErrorText(listingsRes) : '',
      !accountsRes.ok ? await readErrorText(accountsRes) : '',
      !propertiesRes.ok ? await readErrorText(propertiesRes) : '',
    ]
      .filter(Boolean)
      .join(' | ');
    throw new Error(
      details ||
        'No se pudo leer external_listings/source_accounts/properties. Corre primero la migracion de Supabase.'
    );
  }

  const [listings, accounts, properties] = await Promise.all([
    listingsRes.json(),
    accountsRes.json(),
    propertiesRes.json(),
  ]);

  return {
    listings: Array.isArray(listings) ? listings : [],
    accounts: Array.isArray(accounts) ? accounts : [],
    properties: Array.isArray(properties) ? properties : [],
  };
}

function createMappingIndexes({ listings, properties }) {
  const byCloudbedsId = new Map();
  const byPropertyName = new Map();

  for (const listing of listings) {
    const candidates = [
      normalizeText(listing.external_listing_id),
      normalizeText(listing.external_property_id),
      normalizeText(listing.metadata?.cloudbedsPropertyId),
    ].filter(Boolean);
    for (const candidate of candidates) {
      byCloudbedsId.set(candidate, listing);
    }
  }

  for (const property of properties) {
    const key = normalizeKey(property.name);
    if (key) byPropertyName.set(key, property);
  }

  return { byCloudbedsId, byPropertyName };
}

async function resolvePropertyTargets(inputPropertyIds = []) {
  const config = getCloudbedsConfig();
  const requestedIds = inputPropertyIds.length ? inputPropertyIds : config.configuredPropertyIds;
  let hotels = [];

  try {
    const response = await cloudbedsGet('getHotels', requestedIds.length ? { propertyID: requestedIds } : {});
    hotels = parseCloudbedsData(response);
  } catch (error) {
    if (requestedIds.length) {
      hotels = requestedIds.map((propertyID) => ({ propertyID }));
    } else {
      hotels = [{ propertyID: null }];
    }
  }

  const normalized = hotels
    .map((hotel) => ({
      propertyID: normalizeText(
        pick(hotel, ['propertyID', 'propertyId', 'id', 'hotelID', 'hotelId'])
      ),
      propertyName: normalizeText(pick(hotel, ['propertyName', 'name', 'hotelName', 'title'])),
      raw: hotel,
    }))
    .filter((hotel, index, arr) => {
      if (!hotel.propertyID) return arr.length === 1 && index === 0;
      return arr.findIndex((item) => item.propertyID === hotel.propertyID) === index;
    });

  if (!normalized.length) return [{ propertyID: null, propertyName: '' }];
  return normalized;
}

async function fetchSourceMapForProperty(propertyID) {
  try {
    const payload = await cloudbedsGet('getSources', propertyID ? { propertyID } : {});
    const rows = parseCloudbedsData(payload);
    const map = new Map();
    for (const row of rows) {
      const sourceId = normalizeText(pick(row, ['sourceID', 'sourceId', 'id']));
      const sourceName = normalizeText(pick(row, ['sourceName', 'name', 'title']));
      if (sourceId && sourceName) map.set(sourceId, sourceName);
    }
    return map;
  } catch (error) {
    return new Map();
  }
}

function extractGuest(record) {
  const guestName =
    normalizeText(
      pick(record, [
        'guestName',
        'mainGuestName',
        'guest_name',
        'name',
        'customerName',
      ])
    ) ||
    normalizeText(
      [
        pick(record, ['guestFirstName', 'firstName']),
        pick(record, ['guestLastName', 'lastName']),
      ]
        .filter(Boolean)
        .join(' ')
    );

  const guests = ensureArray(record.guests);
  const primaryGuest = guests[0] || null;

  return {
    name:
      guestName ||
      normalizeText(
        [
          pick(primaryGuest || {}, ['firstName', 'guestFirstName']),
          pick(primaryGuest || {}, ['lastName', 'guestLastName']),
        ]
          .filter(Boolean)
          .join(' ')
      ) ||
      normalizeText(
        pick(primaryGuest || {}, ['name', 'guestName', 'fullName', 'email'])
      ),
    email: normalizeText(
      pick(record, ['guestEmail', 'email', 'guest_email']) ||
        pick(primaryGuest || {}, ['email', 'guestEmail'])
    ),
  };
}

function extractRoomName(record) {
  const direct = normalizeText(
    pick(record, ['roomName', 'roomTypeName', 'assignedRoomName', 'roomType', 'room'])
  );
  if (direct) return direct;

  const rooms = ensureArray(record.rooms);
  const firstRoom = rooms[0] || null;
  return normalizeText(
    pick(firstRoom || {}, ['roomName', 'roomTypeName', 'roomType', 'name'])
  );
}

function normalizeChannel(sourceName, sourceId) {
  const key = normalizeKey(sourceName || sourceId);
  if (!key) return 'unknown';
  if (key.includes('booking')) return 'booking';
  if (key.includes('expedia')) return 'expedia';
  if (key.includes('airbnb')) return 'airbnb';
  if (key.includes('vrbo') || key.includes('homeaway')) return 'vrbo';
  if (
    key.includes('website') ||
    key.includes('booking_engine') ||
    key.includes('walk_in') ||
    key.includes('walkin') ||
    key.includes('direct')
  ) {
    return 'direct';
  }
  return slugify(sourceName || sourceId) || 'unknown';
}

function normalizeReservationStatus(status) {
  const key = slugify(status);
  if (!key) return 'unknown';
  if (key === 'checked_out') return 'checked_out';
  if (key === 'checked_in' || key === 'in_house') return 'checked_in';
  if (key === 'confirmed') return 'confirmed';
  if (key === 'in_progress' || key === 'pending') return 'pending';
  if (key === 'canceled' || key === 'cancelled' || key === 'no_show') return 'cancelled';
  if (key === 'not_confirmed') return 'pending';
  return key;
}

function resolveCloudbedsPropertyMapping({
  cloudbedsPropertyId,
  propertyName,
  indexes,
}) {
  const directMatch = indexes.byCloudbedsId.get(normalizeText(cloudbedsPropertyId));
  if (directMatch) {
    return { listing: directMatch, matchType: 'cloudbeds_property_id' };
  }

  const byName = indexes.byPropertyName.get(normalizeKey(propertyName));
  if (byName) {
    return {
      listing: {
        id: null,
        property_id: byName.id,
        source_account_id: null,
        external_listing_id: cloudbedsPropertyId || null,
        external_property_id: cloudbedsPropertyId || null,
      },
      matchType: 'property_name',
    };
  }

  return { listing: null, matchType: null };
}

function chooseSourceAccountId(mapping, accounts, config) {
  if (config.sourceAccountId) return config.sourceAccountId;
  if (mapping?.source_account_id) return mapping.source_account_id;
  if (config.groupAccountId) {
    const matched = accounts.find(
      (account) => normalizeText(account.external_account_id) === config.groupAccountId
    );
    if (matched?.id) return matched.id;
  }
  return accounts.length === 1 ? accounts[0].id : null;
}

function normalizeReservationRecord(record, context) {
  const reservationId = normalizeText(
    pick(record, ['reservationID', 'reservationId', 'id'])
  );
  if (!reservationId) {
    return { skip: { reason: 'missing_reservation_id' } };
  }

  const cloudbedsPropertyId =
    normalizeText(
      pick(record, ['propertyID', 'propertyId', 'hotelID', 'hotelId'])
    ) || context.propertyID;
  const propertyName = normalizeText(
    pick(record, ['propertyName', 'hotelName']) || context.propertyName
  );
  const mappingResult = resolveCloudbedsPropertyMapping({
    cloudbedsPropertyId,
    propertyName,
    indexes: context.indexes,
  });

  if (!mappingResult.listing?.property_id) {
    return {
      skip: {
        reason: 'missing_property_mapping',
        reservationID: reservationId,
        cloudbedsPropertyId,
        propertyName,
      },
    };
  }

  const sourceId = normalizeText(pick(record, ['sourceID', 'sourceId']));
  const sourceName =
    normalizeText(pick(record, ['sourceName', 'source', 'sourceLabel'])) ||
    context.sourceMap.get(sourceId) ||
    '';
  const guest = extractGuest(record);
  const sourceAccountId = chooseSourceAccountId(
    mappingResult.listing,
    context.accounts,
    context.cloudbedsConfig
  );

  const row = {
    property_id: mappingResult.listing.property_id,
    source_account_id: sourceAccountId,
    listing_id: mappingResult.listing.id || null,
    connector: 'cloudbeds',
    channel: normalizeChannel(sourceName, sourceId),
    cloudbeds_reservation_id: reservationId,
    external_reservation_id: normalizeText(
      pick(record, [
        'thirdPartyIdentifier',
        'externalReservationId',
        'externalReservationID',
        'confirmationNumber',
      ])
    ) || null,
    guest_name: guest.name || null,
    guest_email: guest.email || null,
    room_name: extractRoomName(record) || null,
    status: normalizeReservationStatus(pick(record, ['status', 'reservationStatus'])),
    check_in: toIsoDate(
      pick(record, ['startDate', 'checkIn', 'arrivalDate', 'check_in'])
    ),
    check_out: toIsoDate(
      pick(record, ['endDate', 'checkOut', 'departureDate', 'check_out'])
    ),
    booked_at: toIsoDateTime(
      pick(record, ['bookingDate', 'createdAt', 'created_at', 'reservationCreatedAt'])
    ),
    cancelled_at: toIsoDateTime(
      pick(record, ['cancelDate', 'cancelledAt', 'canceledAt'])
    ),
    raw_payload: record,
    metadata: {
      connector: 'cloudbeds',
      cloudbedsPropertyId: cloudbedsPropertyId || null,
      cloudbedsPropertyName: propertyName || null,
      sourceId: sourceId || null,
      sourceName: sourceName || null,
      propertyMatchType: mappingResult.matchType,
      syncedAt: new Date().toISOString(),
    },
  };

  return { row };
}

function buildReservationQuery(payload, propertyID, defaultWindowDays) {
  const query = {};
  const passthroughKeys = [
    'status',
    'includeGuestsDetails',
    'resultsFrom',
    'resultsTo',
    'checkInFrom',
    'checkInTo',
    'CheckInFrom',
    'CheckInTo',
    'checkOutFrom',
    'checkOutTo',
    'CheckOutFrom',
    'CheckOutTo',
    'checkedOutFrom',
    'checkedOutTo',
    'modifiedFrom',
    'modifiedTo',
  ];

  for (const key of passthroughKeys) {
    if (payload[key] !== undefined && payload[key] !== null && payload[key] !== '') {
      query[key] = payload[key];
    }
  }

  if (propertyID) query.propertyID = propertyID;
  query.includeGuestsDetails =
    payload.includeGuestsDetails === false ? 'false' : String(query.includeGuestsDetails || true);

  const hasWindow =
    query.checkInFrom ||
    query.CheckInFrom ||
    query.checkOutFrom ||
    query.CheckOutFrom ||
    query.checkedOutFrom ||
    query.modifiedFrom;

  if (!hasWindow) {
    query.checkedOutFrom = subtractDays(defaultWindowDays);
    query.checkedOutTo = new Date().toISOString().slice(0, 10);
    if (!query.status) query.status = 'checked_out';
  }

  if (!query.resultsFrom) query.resultsFrom = '1';
  if (!query.resultsTo) query.resultsTo = '500';

  return query;
}

function chunk(items, size = DEFAULT_BATCH_SIZE) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

async function upsertReservations(rows) {
  if (!rows.length) return [];
  const { url } = getSupabaseConfig();
  const response = await fetch(
    `${url}/rest/v1/reservations?on_conflict=cloudbeds_reservation_id`,
    {
      method: 'POST',
      headers: createSupabaseHeaders({
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation',
      }),
      body: JSON.stringify(rows),
    }
  );

  if (!response.ok) {
    const details = await readErrorText(response);
    throw new Error(details || `Supabase devolvio ${response.status} al upsert de reservations`);
  }

  try {
    const data = await response.json();
    return Array.isArray(data) ? data : [];
  } catch (error) {
    return [];
  }
}

async function syncCloudbedsReservations(payload = {}) {
  const cloudbedsConfig = getCloudbedsConfig();
  const propertyTargets = await resolvePropertyTargets(
    ensureArray(payload.propertyIds).map((id) => normalizeText(id)).filter(Boolean)
  );
  const supabaseMappings = await listSupabaseCloudbedsMappings();
  const indexes = createMappingIndexes(supabaseMappings);

  const reservationIds = ensureArray(payload.reservationIds)
    .map((id) => normalizeText(id))
    .filter(Boolean);

  if (reservationIds.length && propertyTargets.length > 1) {
    throw new Error(
      'reservationIds requiere una sola propiedad objetivo. Envía propertyIds con un solo Cloudbeds propertyID'
    );
  }

  const summary = {
    propertiesScanned: 0,
    reservationsFetched: 0,
    reservationsPrepared: 0,
    reservationsUpserted: 0,
    skipped: [],
    mode: reservationIds.length ? 'reservation_ids' : 'window_sync',
  };

  const rows = [];

  for (const target of propertyTargets) {
    summary.propertiesScanned += 1;
    const sourceMap = await fetchSourceMapForProperty(target.propertyID);

    if (reservationIds.length) {
      for (const reservationID of reservationIds) {
        const reservationPayload = await cloudbedsGet('getReservation', {
          reservationID,
          ...(target.propertyID ? { propertyID: target.propertyID } : {}),
        });
        const reservation = parseCloudbedsObject(reservationPayload);
        summary.reservationsFetched += 1;
        const normalized = normalizeReservationRecord(reservation, {
          propertyID: target.propertyID,
          propertyName: target.propertyName,
          sourceMap,
          indexes,
          accounts: supabaseMappings.accounts,
          cloudbedsConfig,
        });
        if (normalized.skip) {
          summary.skipped.push(normalized.skip);
          continue;
        }
        rows.push(normalized.row);
      }
      continue;
    }

    const reservationPayload = await cloudbedsGet(
      'getReservations',
      buildReservationQuery(payload, target.propertyID, cloudbedsConfig.defaultSyncWindowDays)
    );
    const reservations = parseCloudbedsData(reservationPayload);
    summary.reservationsFetched += reservations.length;

    for (const reservation of reservations) {
      const normalized = normalizeReservationRecord(reservation, {
        propertyID: target.propertyID,
        propertyName: target.propertyName,
        sourceMap,
        indexes,
        accounts: supabaseMappings.accounts,
        cloudbedsConfig,
      });
      if (normalized.skip) {
        summary.skipped.push(normalized.skip);
        continue;
      }
      rows.push(normalized.row);
    }
  }

  summary.reservationsPrepared = rows.length;

  for (const batch of chunk(rows)) {
    const saved = await upsertReservations(batch);
    summary.reservationsUpserted += saved.length || batch.length;
  }

  return {
    ...summary,
    propertyTargets,
    skippedCount: summary.skipped.length,
  };
}

module.exports = {
  json,
  requireSyncAccess,
  syncCloudbedsReservations,
};
