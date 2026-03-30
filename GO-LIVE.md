# Go Live Checklist

Checklist rápida para publicar `homirent.reviews` y validar que todo funcione en producción.

## 1. Revisión local

Desde la raíz del proyecto:

```bash
npm run dev
```

Valida:

- `http://127.0.0.1:4173/form.html`
- `http://127.0.0.1:4173/dashboard.html`
- Login del dashboard:
  - Usuario: `admin`
  - Contraseña: `Soporte123*`

## 2. Publicar en Netlify

Opción simple:

1. Entra a Netlify.
2. Usa `Add new site`.
3. Sube esta carpeta completa o conecta el repo.
4. Publica la raíz del proyecto.

Archivos importantes para deploy:

- `form.html`
- `dashboard.html`
- `index.html`
- `netlify.toml`

## 3. URLs a revisar en producción

Reemplaza `TU-DOMINIO` por el dominio final de Netlify:

- `https://TU-DOMINIO/`
- `https://TU-DOMINIO/form.html`
- `https://TU-DOMINIO/dashboard.html`

## 4. Prueba operativa mínima

Haz esta prueba completa:

1. Abre `form.html`.
2. Envía una review real de prueba.
3. Abre `dashboard.html`.
4. Inicia sesión.
5. Confirma que la review aparece en:
   - Overview
   - Todas las Reviews
   - Analytics

## 5. Prueba de links por complejo

Dentro del dashboard:

1. Ve a `Links por Complejo`.
2. Copia un link tipo `iPad`.
3. Ábrelo en otra pestaña.
4. Verifica que el complejo llegue preseleccionado y bloqueado.
5. Copia un link tipo `QR`.
6. Abre el preview del QR.
7. Descarga el PNG.
8. Imprime uno.

## 6. Prueba en celular o iPad

Valida:

- que el formulario se vea bien en vertical
- que el envío funcione con internet móvil o Wi‑Fi
- que el auto-reset funcione en links con `?source=ipad`

## 7. Antes de compartir al equipo

Confirma:

- que el dashboard sí pide login
- que Supabase sigue devolviendo propiedades activas
- que `Export CSV` descarga el archivo correctamente
- que los QR abren la URL pública, no la local

## 8. Recomendación inmediata después del go live

Después de publicarlo, genera y prueba:

- 1 QR por complejo prioritario
- 1 link de iPad por recepción
- 1 prueba de rating bajo para revisar alertas
