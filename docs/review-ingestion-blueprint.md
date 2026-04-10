# Review Ingestion Blueprint

Arquitectura objetivo para centralizar reviews y contexto operativo sin depender de `Cloudbeds Reputation`.

## Objetivo

Centralizar en `homirent.reviews`:

- reviews directas del formulario propio
- contexto operativo de estancias desde Cloudbeds
- reviews o mensajes de Airbnb recibidos por email
- más adelante reviews de Booking y Expedia si se habilita una integración formal

## Principios

1. `Cloudbeds` sigue siendo el sistema maestro de reservas.
2. `homirent.reviews` no reemplaza el PMS: lo complementa.
3. `property` es la entidad maestra interna.
4. `connector` y `channel` no significan lo mismo.

## Definiciones

- `property`
  Complejo interno de Homi.

- `connector`
  Sistema o integración lógica por donde llegó el dato.
  Ejemplos:
  - `cloudbeds`
  - `airbnb`
  - `email`
  - `manual`

- `channel`
  Canal comercial original de la estancia o review.
  Ejemplos:
  - `direct`
  - `booking`
  - `expedia`
  - `airbnb`

## Ejemplos rápidos

- Reserva de Booking importada desde Cloudbeds:
  - `connector = cloudbeds`
  - `channel = booking`

- Review de Airbnb parseada desde correo reenviado:
  - `connector = airbnb` si usas un inbox dedicado por cuenta Airbnb
  - `channel = airbnb`

- Correo genérico que entra por un inbox central y aún no clasificas:
  - `connector = email`
  - `channel_guess = airbnb | booking | expedia | null`

## Tablas base

El esquema ya preparado en Supabase soporta estas piezas:

- `properties`
- `source_accounts`
- `external_listings`
- `reservations`
- `inbound_messages`
- `reviews`

## Flujo A: Cloudbeds -> reservations

### Qué queremos traer

Solo el contexto mínimo necesario:

- reserva
- complejo
- canal original
- fechas
- huésped
- estado
- identificadores externos

### Qué no queremos traer al inicio

- pagos
- contabilidad
- inventario completo
- pricing history

### Entrada recomendada

Combinar dos mecanismos:

1. `sync programado`
   Corre cada 5-15 minutos para reconciliar datos.

2. `webhooks`
   Para enterarte rápido de reservas nuevas o cambios importantes.

### Eventos prioritarios

- nueva reserva
- cambio de estado
- check-in
- check-out
- cancelación

### Transformación

Cada reserva importada debe terminar en `public.reservations` con estas decisiones:

- `property_id`
  Se obtiene por mapping desde `external_listings` o desde la relación conocida del property en Cloudbeds.

- `connector = cloudbeds`

- `channel`
  Se normaliza desde el origen de la reserva:
  - `booking`
  - `expedia`
  - `direct`
  - otro valor conocido

- `cloudbeds_reservation_id`
  Identificador estable para idempotencia.

- `external_reservation_id`
  Si existe un ID del canal, también se guarda.

### Idempotencia

La operación debe ser `upsert`, no `insert` ciego.

Claves sugeridas:

- primera opción: `cloudbeds_reservation_id`
- segunda opción: `(connector, external_reservation_id)`

### Estados internos recomendados

Usar estos valores en `reservations.status`:

- `pending`
- `confirmed`
- `checked_in`
- `checked_out`
- `cancelled`
- `unknown`

### Momento clave para automatización

Cuando una reserva pase a `checked_out`, se puede:

- programar encuesta propia post-estancia
- abrir una ventana de seguimiento de reputación
- esperar posibles correos de review y hacer matching más confiable

## Flujo B: Email/Airbnb -> inbound_messages -> reviews

### Objetivo

No depender de una API oficial de Airbnb para empezar.

### Entrada recomendada

Usar un inbox controlado por ustedes:

- un inbox dedicado para reenvíos de Airbnb
- o un inbox operativo central

### Recomendación técnica

Ingerir correo por proveedor oficial:

- Gmail API push
- Microsoft Graph webhooks

Evitar:

- scraping de interfaces web
- IMAP improvisado como solución principal

### Pipeline

#### Paso 1: Captura

Guardar cada correo crudo en `inbound_messages`.

Campos mínimos:

- `source_account_id`
- `connector`
- `from_email`
- `subject`
- `received_at`
- `raw_text`
- `raw_html`
- `headers`
- `parse_status = pending`

#### Paso 2: Clasificación

Clasificar el mensaje en una de estas familias:

- `review_notification`
- `guest_message`
- `reservation_confirmation`
- `post_stay_prompt`
- `other`

Resultado esperado:

- `channel_guess`
- `metadata.message_type`
- `parse_status = classified`

#### Paso 3: Parsing

Extraer todo lo posible:

- `guest_name`
- `rating`
- `review_text`
- `external_review_id`
- `external_reservation_id`
- `listing_name`
- `listing_id_hint`
- `stay_dates`

Resultado esperado:

- `metadata.parsed_fields`
- `parse_status = parsed`

#### Paso 4: Matching

Intentar unir el mensaje con:

1. `external_listings`
2. `reservations`
3. `properties`

Orden sugerido de matching:

1. `external_review_id` o `external_reservation_id`
2. `listing_id` exacto
3. `listing_name` normalizado
4. `guest_name + check_out window + channel`
5. `guest_name + property + date window`

#### Paso 5: Resultado del matching

Estados recomendados:

- `matched`
- `needs_review`
- `ignored`
- `failed`

Si el matching es confiable:

- crea o actualiza `reviews`
- vincula `reservation_id`
- vincula `property_id`

Si no es confiable:

- deja el mensaje en cola manual
- conserva `match_confidence` y motivos

## Algoritmo de matching recomendado

Usar puntaje acumulado de 0.0 a 1.0.

Ejemplo:

- `+0.60` si coincide `external_reservation_id`
- `+0.25` si coincide listing exacta
- `+0.10` si coincide huésped normalizado
- `+0.05` si cae en ventana de fechas esperada

Reglas:

- `>= 0.85`
  auto-match

- `0.60 - 0.84`
  revisión manual asistida

- `< 0.60`
  no vincular automáticamente

## Flujo C: Creación de reviews unificadas

La tabla `reviews` debe ser el destino final de cualquier review útil.

### Casos

- formulario propio
  - `connector = direct_app`
  - `channel = direct`
  - `source_type = direct_form`

- encuesta post-estancia propia
  - `connector = direct_app`
  - `channel = direct`
  - `source_type = post_stay`

- review OTA obtenida desde Cloudbeds o integración futura
  - `connector = cloudbeds` o conector futuro
  - `channel = booking | expedia`
  - `source_type = ota`

- review Airbnb parseada desde correo
  - `connector = airbnb` o `email`
  - `channel = airbnb`
  - `source_type = email_parsed`

### Reglas de deduplicación

Antes de insertar:

1. si existe `external_review_id`, úsalo como clave principal de dedupe
2. si no existe, usa combinación débil:
   - `channel`
   - `guest_name`
   - `property_id`
   - ventana corta de `reviewed_at`
   - hash de comentario

## Contrato operativo sugerido

## Endpoint 1: Cloudbeds Sync

- ruta sugerida: `/api/internal/cloudbeds-sync`
- método: `POST`
- autenticación: token interno o cron secret

Payload mínimo:

```json
{
  "mode": "incremental",
  "from": "2026-04-01T00:00:00Z"
}
```

Responsabilidad:

- leer cambios en Cloudbeds
- hacer upsert a `reservations`
- actualizar `external_listings` si se detectan mappings nuevos
- registrar métricas de sync

## Endpoint 2: Inbound Email Webhook

- ruta sugerida: `/api/inbound/email`
- método: `POST`
- autenticación: firma del proveedor o secret compartido

Payload lógico:

```json
{
  "provider": "gmail",
  "sourceAccountId": "uuid",
  "externalMessageId": "msg_123",
  "threadId": "thr_123"
}
```

Responsabilidad:

- recuperar el mensaje completo desde el proveedor
- persistirlo en `inbound_messages`
- encolar clasificación/parsing

## Endpoint 3: Review Match Worker

- ruta sugerida: `/api/internal/process-inbound-message`
- método: `POST`

Payload lógico:

```json
{
  "inboundMessageId": "uuid",
  "force": false
}
```

Responsabilidad:

- parsear
- calcular candidatos
- crear o actualizar `reviews`
- dejar trazabilidad del resultado

## Cola operativa sugerida

Aunque al inicio sea simple, piensa en tres jobs separados:

- `cloudbeds_sync_job`
- `email_ingest_job`
- `message_parse_match_job`

Esto permite reintentos y evita mezclar fallos de red con fallos de parsing.

## Métricas mínimas

Medir desde el día uno:

- reservas sincronizadas por día
- mensajes entrantes por conector
- porcentaje de auto-match
- porcentaje de revisión manual
- tiempo desde recepción del correo hasta review disponible
- reviews nuevas por canal

## Fase 1 recomendada

### Entregables

1. Sync básico de Cloudbeds a `reservations`
2. Ingesta de inbox Airbnb a `inbound_messages`
3. Matching manual asistido
4. Lectura de reviews unificadas en dashboard interno

### Meta de la fase

Que ya puedas ver en una sola plataforma:

- reviews directas
- reviews Airbnb parseadas
- contexto de reserva y complejo

## Fase 2 recomendada

- clasificación automática más robusta
- respuestas sugeridas por IA
- cola de trabajo para reviews sin responder
- soporte para Booking y Expedia si hay acceso formal

## Riesgos conocidos

- templates de email de Airbnb pueden cambiar
- algunos correos no traerán IDs completos
- habrá reseñas que requieran revisión manual
- el mapping inicial de listings debe estar bien hecho o el matching sufrirá

## Decisiones ya tomadas

- no usar `Cloudbeds Reputation` como dependencia obligatoria
- no mezclar `connector` con `channel`
- no reemplazar Cloudbeds como PMS
- sí usar Cloudbeds como capa de contexto operativo
- sí permitir que Airbnb viva fuera de Cloudbeds pero dentro del mismo modelo
