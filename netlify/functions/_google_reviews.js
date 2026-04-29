const crypto = require('crypto');

const {
  createSupabaseHeaders,
  getSupabaseConfig,
  readErrorText,
} = require('./_dashboard');

const PLACE_IDS = [
  { placeId: 'ChIJHffRWDxb04URfbR8C_d3L3c', supabaseName: 'El Doce' },
  { placeId: 'ChIJo8PM5OJb04URQDCHwa-h0Z8', supabaseName: 'Morelos' },
  { placeId: 'ChIJd5U7mv__0YURHqJMhNmLtZI', supabaseName: 'Prosperidad' },
  { placeId: 'ChIJ92qN9ndzVo8ReRq67A4SuU8', supabaseName: 'Suites Reforma' },
  { placeId: 'ChIJvfLQcT1F04URBXwQ_C9W6uI', supabaseName: 'Hacienda Santa Bárbara' },
  { placeId: 'ChIJwTjF-4pF04URvvbRKSlx_MU', supabaseName: 'Ezequiel Montes' },
  { placeId: 'ChIJ5xonnMxb04URKsQrBibYgkw', supabaseName: 'Suite Álamos' },
  { placeId: 'ChIJUySTZRBb04URL0rS3wccbMk', supabaseName: 'Universidad' },
  { placeId: 'ChIJbwriYZBb04URbHfhrVaf7bA', supabaseName: 'Allende' },
];

const LEGACY_GOOGLE_EXTERNAL_ID_RE = /^google_[A-Za-z0-9_-]+_[A-Za-z0-9+/=]+$/;

function normalizeText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function buildGoogleReviewExternalId(review, placeId) {
  const resourceName = normalizeText(review?.name);
  if (resourceName) {
    return `google_review:${resourceName}`;
  }

  const fallback = [
    placeId,
    normalizeText(review?.publishTime),
    normalizeText(review?.authorAttribution?.displayName),
    normalizeText(review?.text?.text),
    review?.rating ?? '',
  ].join('|');

  return `google_review_fallback:${placeId}:${crypto
    .createHash('sha256')
    .update(fallback)
    .digest('hex')}`;
}

function isLegacyGoogleExternalId(externalId) {
  return LEGACY_GOOGLE_EXTERNAL_ID_RE.test(String(externalId || ''));
}

function matchesLegacyGoogleReview(review, row) {
  const reviewGuest = normalizeText(review?.authorAttribution?.displayName);
  const rowGuest = normalizeText(row?.guest_name);
  if (reviewGuest && rowGuest && reviewGuest !== rowGuest) return false;

  const reviewPublishedAt = normalizeText(review?.publishTime);
  const rowPublishedAt = normalizeText(row?.published_at);
  if (reviewPublishedAt && rowPublishedAt && reviewPublishedAt !== rowPublishedAt) return false;

  if (review?.rating != null && row?.rating != null && Number(review.rating) !== Number(row.rating)) {
    return false;
  }

  const reviewComment = normalizeText(review?.text?.text);
  const rowComment = normalizeText(row?.comment);
  if (reviewComment && rowComment && reviewComment !== rowComment) return false;

  return Boolean(
    (reviewPublishedAt && rowPublishedAt) ||
      (reviewGuest && rowGuest && reviewComment && rowComment) ||
      (reviewGuest && rowGuest && review?.rating != null && row?.rating != null)
  );
}

function getGoogleConfig() {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error('Falta GOOGLE_PLACES_API_KEY en el entorno');
  return { apiKey };
}

async function fetchPlaceReviews(apiKey, placeId) {
  const url = `https://places.googleapis.com/v1/places/${placeId}`;
  const res = await fetch(url, {
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'id,displayName,rating,userRatingCount,reviews',
      'Accept-Language': 'es',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Places devolvio ${res.status}: ${text}`);
  }

  return res.json();
}

async function resolvePropertyId(supabaseName) {
  const { url } = getSupabaseConfig();
  const headers = createSupabaseHeaders();
  const res = await fetch(
    `${url}/rest/v1/properties?select=id,name&name=eq.${encodeURIComponent(supabaseName)}&active=eq.true`,
    { headers }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows?.[0]?.id || null;
}

async function listGoogleReviewsForPlace(placeId) {
  const { url } = getSupabaseConfig();
  const headers = createSupabaseHeaders();
  const params = new URLSearchParams({
    select: 'id,external_id,guest_name,rating,comment,published_at,responded,responded_at',
    place_id: `eq.${placeId}`,
  });

  const res = await fetch(`${url}/rest/v1/google_reviews?${params.toString()}`, { headers });

  if (!res.ok) {
    const details = await readErrorText(res);
    throw new Error(details || `Supabase devolvio ${res.status} al leer google_reviews`);
  }

  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

async function deleteGoogleReviewsByIds(ids = []) {
  if (!ids.length) return 0;

  const { url } = getSupabaseConfig();
  const res = await fetch(
    `${url}/rest/v1/google_reviews?id=in.(${ids.map((id) => encodeURIComponent(id)).join(',')})`,
    {
      method: 'DELETE',
      headers: createSupabaseHeaders({
        Prefer: 'return=representation',
      }),
    }
  );

  if (!res.ok) {
    const details = await readErrorText(res);
    throw new Error(details || `Supabase devolvio ${res.status} al borrar google_reviews legacy`);
  }

  try {
    const rows = await res.json();
    return Array.isArray(rows) ? rows.length : 0;
  } catch (error) {
    return ids.length;
  }
}

function buildGoogleReviewRow(review, propertyId, placeId, existingRows, matchedLegacyIds) {
  const externalId = buildGoogleReviewExternalId(review, placeId);
  const authorUri = review.authorAttribution?.uri || '';
  const canonicalExists = existingRows.some((row) => row.external_id === externalId);
  const legacyMatch = canonicalExists
    ? null
    : existingRows.find(
        (row) =>
          isLegacyGoogleExternalId(row.external_id) &&
          !matchedLegacyIds.has(row.id) &&
          matchesLegacyGoogleReview(review, row)
      );

  const row = {
    property_id: propertyId,
    source: 'google',
    external_id: externalId,
    guest_name: review.authorAttribution?.displayName || null,
    rating: review.rating || null,
    comment: review.text?.text || null,
    review_url: authorUri || null,
    place_id: placeId,
    original_language: review.originalLanguage || null,
    published_at: review.publishTime || null,
  };

  if (!canonicalExists && legacyMatch) {
    row.responded = Boolean(legacyMatch.responded);
    row.responded_at = legacyMatch.responded_at || null;
    matchedLegacyIds.add(legacyMatch.id);
  }

  return row;
}

async function upsertGoogleReview(row) {
  const { url } = getSupabaseConfig();
  const headers = createSupabaseHeaders();

  const res = await fetch(
    `${url}/rest/v1/google_reviews?on_conflict=external_id`,
    {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(row),
    }
  );

  if (!res.ok) {
    const details = await readErrorText(res);
    throw new Error(details || `Supabase devolvio ${res.status} al upsert google_review`);
  }
}

async function syncGoogleReviews() {
  const { apiKey } = getGoogleConfig();

  const summary = {
    propertiesScanned: 0,
    reviewsFetched: 0,
    reviewsUpserted: 0,
    legacyRowsDeleted: 0,
    skipped: [],
  };

  for (const { placeId, supabaseName } of PLACE_IDS) {
    summary.propertiesScanned += 1;

    const propertyId = await resolvePropertyId(supabaseName);
    if (!propertyId) {
      summary.skipped.push({ reason: 'property_not_found', supabaseName });
      continue;
    }

    let placeData;
    try {
      placeData = await fetchPlaceReviews(apiKey, placeId);
    } catch (err) {
      summary.skipped.push({ reason: 'google_api_error', supabaseName, error: err.message });
      continue;
    }

    const reviews = placeData.reviews || [];
    summary.reviewsFetched += reviews.length;
    const existingRows = await listGoogleReviewsForPlace(placeId);
    const matchedLegacyIds = new Set();
    let placeHadUpsertError = false;

    for (const review of reviews) {
      try {
        const row = buildGoogleReviewRow(
          review,
          propertyId,
          placeId,
          existingRows,
          matchedLegacyIds
        );
        await upsertGoogleReview(row);
        summary.reviewsUpserted += 1;
      } catch (err) {
        placeHadUpsertError = true;
        summary.skipped.push({ reason: 'upsert_error', supabaseName, error: err.message });
      }
    }

    if (!placeHadUpsertError) {
      const legacyIds = existingRows
        .filter((row) => matchedLegacyIds.has(row.id))
        .map((row) => row.id);

      if (legacyIds.length) {
        summary.legacyRowsDeleted += await deleteGoogleReviewsByIds(legacyIds);
      }
    }
  }

  return summary;
}

module.exports = {
  PLACE_IDS,
  buildGoogleReviewExternalId,
  isLegacyGoogleExternalId,
  syncGoogleReviews,
};
