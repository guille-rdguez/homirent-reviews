const { requireSession, json, serverError, methodNotAllowed } = require('./_dashboard');

const PROPERTIES = [
  { name: 'El Doce by Homi Rent', address: 'Av. industrialización No. 12, Alamos 2da Sección, Querétaro' },
  { name: 'Morelos by Homi Rent', address: 'C. José Ma. Morelos 52, Centro, Querétaro' },
  { name: 'Prosperidad by Homi Rent', address: 'C. de la Prosperidad 93, Escandón, Ciudad de México' },
  { name: 'Suites Reforma by HomiRent', address: 'Calle 33B 544, García Ginerés, Mérida, Yucatán' },
  { name: 'Hacienda Santa Barbara By Homirent', address: 'Hacienda Sta. Barbara 105, El Jacal, Querétaro' },
  { name: 'Ezequiel Montes By Homirent', address: 'Calle Ezequiel Montes 50, Centro, Querétaro' },
  { name: 'Suites Álamos by Homirent', address: 'Epigmenio González 913, Alámos, Querétaro' },
  { name: 'Universidad By HomiRent', address: 'Avenida Universidad 9B, Centro, Querétaro' },
  { name: 'Allende by Homi Rent', address: 'C. Ignacio Allende 23, Centro, Querétaro' },
];

async function findPlaceId(apiKey, name, address) {
  const query = `${name} ${address}`;
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.rating',
    },
    body: JSON.stringify({ textQuery: query, languageCode: 'es' }),
  });

  const data = await res.json();
  const place = data.places?.[0];
  if (!place) return { name, found: false };
  return {
    name,
    found: true,
    placeId: place.id,
    displayName: place.displayName?.text,
    address: place.formattedAddress,
    rating: place.rating,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed('GET');
  const { error } = requireSession(event);
  if (error) return error;

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return serverError('Falta GOOGLE_PLACES_API_KEY en el entorno');

  const results = await Promise.all(
    PROPERTIES.map((p) => findPlaceId(apiKey, p.name, p.address))
  );

  return json(200, { ok: true, results });
};
