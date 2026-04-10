# homirent.reviews

Proyecto interno de Homi Rent para capturar y analizar reviews de huéspedes.

## Archivos principales

- `index.html`: portada local con accesos rápidos.
- `form.html`: formulario público para huéspedes.
- `dashboard.html`: dashboard interno para centro de control.
- `serve-local.py`: servidor estático local sin dependencias.
- `netlify.toml`: configuración básica para deploy estático.
- `.netlifyignore`: excluye archivos de desarrollo del deploy.
- `GO-LIVE.md`: checklist de publicación y validación en producción.
- `docs/review-ingestion-blueprint.md`: blueprint de arquitectura para centralizar reviews desde Cloudbeds, Airbnb y email.
- `supabase/migrations/*`: base SQL para soportar conectores externos y reviews unificadas.

## Correr en local

Si vas a usar el dashboard seguro en local, define estas variables en tu shell o crea un archivo `.env` basado en `.env.example`:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` recomendado
- `SUPABASE_DASHBOARD_KEY` opcional como fallback temporal para pruebas si todavia no tienes service role
- `DASHBOARD_USERNAME`
- `DASHBOARD_PASSWORD` o `DASHBOARD_PASSWORD_HASH`
- `DASHBOARD_SESSION_SECRET`
- `DASHBOARD_SESSION_HOURS` opcional

La forma más cómoda:

```bash
npm run dev
```

También funciona:

```bash
python3 serve-local.py
```

Después abre:

- `http://127.0.0.1:4173/`
- `http://127.0.0.1:4173/form.html`
- `http://127.0.0.1:4173/dashboard.html`

Si `4173` ya está ocupado, `serve-local.py` usa el siguiente puerto libre y te imprime las URLs correctas en consola.

`serve-local.py` también expone:

- `/api/dashboard-login`
- `/api/dashboard-session`
- `/api/dashboard-data`
- `/api/dashboard-logout`
- `/api/internal/cloudbeds-sync`
- `/api/inbound/email`
- `/api/internal/process-inbound-message`

Para probarlo desde otro dispositivo en la misma red:

```bash
npm run dev:public
```

## Deploy en Netlify

1. Entra a Netlify.
2. Crea un nuevo sitio desde carpeta o arrastra este directorio.
3. Configura las variables de entorno del dashboard:
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DASHBOARD_USERNAME`, `DASHBOARD_PASSWORD` o `DASHBOARD_PASSWORD_HASH`, `DASHBOARD_SESSION_SECRET`.
4. Publica la raíz del proyecto.
5. El sitio quedará listo sin build adicional.

Rutas principales en producción:

- `/`
- `/form.html`
- `/dashboard.html`

## Notas

- No hace falta `npm install`.
- No hace falta bundler.
- El proyecto consume Supabase vía REST, así que necesita internet para leer y guardar datos reales.
- El formulario público sigue consumiendo Supabase vía REST desde frontend.
- El dashboard interno ahora lee datos a través de `/api/*`, usando backend con sesión firmada y variables de entorno seguras.
- Para local, `SUPABASE_DASHBOARD_KEY` te permite probar el backend del dashboard mientras consigues el `SUPABASE_SERVICE_ROLE_KEY`. Para producción, usa `SUPABASE_SERVICE_ROLE_KEY`.
- `cloudbeds-sync` necesita que ya hayas corrido la migración de Supabase y mapeado tus `external_listings` de Cloudbeds.

## Cloudbeds Sync

Ya existe un endpoint interno para sincronizar reservas mínimas desde Cloudbeds hacia `reservations`.

Ruta:

- `POST /api/internal/cloudbeds-sync`

Autorización:

- sesión válida del dashboard, o
- header `X-Sync-Secret` si defines `CLOUDBEDS_SYNC_SECRET`

Variables de entorno mínimas:

- `CLOUDBEDS_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Variables recomendadas:

- `CLOUDBEDS_PROPERTY_IDS`
- `CLOUDBEDS_GROUP_ACCOUNT_ID`
- `CLOUDBEDS_SOURCE_ACCOUNT_ID`
- `CLOUDBEDS_DEFAULT_SYNC_WINDOW_DAYS`
- `CLOUDBEDS_SYNC_SECRET`

Ejemplo de llamada:

```bash
curl -X POST http://127.0.0.1:4173/api/internal/cloudbeds-sync \
  -H "Content-Type: application/json" \
  -H "X-Sync-Secret: TU_SECRETO" \
  -d '{"checkedOutFrom":"2026-04-01","checkedOutTo":"2026-04-06","propertyIds":["200001"]}'
```

Si no mandas ventana, el endpoint usa por defecto una ventana de reviews post-estancia con `checkedOutFrom` de los últimos 14 días y `status=checked_out`.

## Inbound Email

Ya existe el pipeline base para:

- guardar correos o eventos entrantes en `inbound_messages`
- clasificarlos
- parsear campos útiles
- intentar convertirlos en `reviews` cuando el matching sea suficientemente confiable

Rutas:

- `POST /api/inbound/email`
- `POST /api/internal/process-inbound-message`

Autorización:

- sesión válida del dashboard, o
- header `X-Inbound-Secret` si defines `INBOUND_EMAIL_SECRET`

Variables útiles:

- `INBOUND_EMAIL_SECRET`
- `INBOUND_AUTO_MATCH_THRESHOLD`

Ejemplo de ingestión:

```bash
curl -X POST http://127.0.0.1:4173/api/inbound/email \
  -H "Content-Type: application/json" \
  -H "X-Inbound-Secret: TU_SECRETO" \
  -d '{
    "provider":"manual",
    "connector":"airbnb",
    "externalMessageId":"msg_airbnb_001",
    "threadId":"thread_airbnb_001",
    "fromEmail":"automated@airbnb.com",
    "subject":"You received a new review from Maria",
    "text":"Review from Maria\nRating: 5/5\nListing: Airbnb - Hacienda Santa Barbara Loft 1\nReservation code: HM12345\nComment: Great stay and very clean.",
    "autoProcess": true
  }'
```

Ejemplo de reproceso manual:

```bash
curl -X POST http://127.0.0.1:4173/api/internal/process-inbound-message \
  -H "Content-Type: application/json" \
  -H "X-Inbound-Secret: TU_SECRETO" \
  -d '{"inboundMessageId":"UUID_DEL_MENSAJE","force":false}'
```

## Compatibilidad

Los archivos descargados con nombres temporales:

- `2-formulario-huespedes (1).html`
- `3-dashboard-interno (1).html`

se conservan como redirecciones locales hacia los nombres canónicos.
