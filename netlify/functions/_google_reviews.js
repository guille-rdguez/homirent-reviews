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

async function upsertGoogleReview(review, propertyId, placeId) {
  const { url } = getSupabaseConfig();
  const headers = createSupabaseHeaders();

  const authorUri = review.authorAttribution?.uri || '';
  const externalId = `google_${placeId}_${Buffer.from(authorUri || review.name || Math.random().toString()).toString('base64').slice(0, 16)}`;

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
    responded: false,
  };

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

    for (const review of reviews) {
      try {
        await upsertGoogleReview(review, propertyId, placeId);
        summary.reviewsUpserted += 1;
      } catch (err) {
        summary.skipped.push({ reason: 'upsert_error', supabaseName, error: err.message });
      }
    }
  }

  return summary;
}

module.exports = { syncGoogleReviews, PLACE_IDS };
