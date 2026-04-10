# Supabase Schema

Base inicial para escalar `homirent.reviews` sin romper el flujo actual de `properties` + `reviews`.

## Archivo principal

- `supabase/migrations/20260406_external_review_foundation.sql`
- `supabase/seeds/20260406_bootstrap_accounts_and_listings.example.sql`

## Qué agrega

- `source_accounts`: cuentas conectadas como Cloudbeds, buzones de email o conectores manuales.
- `external_listings`: mapeo entre un complejo interno y sus listings externas.
- `reservations`: capa mínima operativa para relacionar estancia, canal y review.
- `inbound_messages`: almacenamiento de correos o eventos entrantes para parsing.
- Extensión de `reviews` con campos para conectores, listings, reservas y estado de respuesta.

## Compatibilidad

Esta migración:

- no elimina columnas existentes
- no renombra `properties`
- no renombra `reviews`
- no modifica el flujo actual del formulario ni del dashboard

El dashboard actual seguirá leyendo:

- `properties(id, city, name)`
- `reviews(id, guest_name, room_name, rating, comment, would_return, source, created_at, property_id)`

porque esas columnas permanecen intactas.

## Cómo aplicarla

Desde el SQL Editor de Supabase o tu flujo de migraciones:

```sql
\i supabase/migrations/20260406_external_review_foundation.sql
```

Si usas el editor web de Supabase, copia y ejecuta el contenido completo del archivo.

Para bootstrap inicial de cuentas y listings:

- abre `supabase/seeds/20260406_bootstrap_accounts_and_listings.example.sql`
- reemplaza los `TODO_*`
- ejecútalo por bloques

## Modelo resultante

- `properties`
  Catálogo maestro interno de complejos.

- `source_accounts`
  Define de dónde vienen los datos.
  Ejemplos:
  - `cloudbeds`
  - `airbnb`
  - `email`
  - `manual`

- `external_listings`
  Permite mapear varias listings externas hacia un mismo complejo interno.

- `reservations`
  Sirve como capa de contexto mínimo para matching, automatizaciones y analítica por canal.

- `inbound_messages`
  Guarda correos o mensajes crudos para clasificación y trazabilidad.

- `reviews`
  Sigue funcionando para reviews directas, pero ahora también soporta reviews OTA y reviews parseadas desde email.

## Primeros seeds sugeridos

Después de correr la migración, los primeros datos manuales útiles serían:

1. Crear un `source_account` para Cloudbeds.
2. Crear un `source_account` para el inbox que recibirá emails de Airbnb.
3. Mapear en `external_listings` las listings de Airbnb hacia sus `properties`.

Ya dejé un template de ejemplo con esos pasos en:

- `supabase/seeds/20260406_bootstrap_accounts_and_listings.example.sql`

Con eso ya puedes empezar a guardar:

- reservas desde Cloudbeds en `reservations`
- correos entrantes en `inbound_messages`
- reviews unificadas en `reviews`
