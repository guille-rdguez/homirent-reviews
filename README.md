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

## Compatibilidad

Los archivos descargados con nombres temporales:

- `2-formulario-huespedes (1).html`
- `3-dashboard-interno (1).html`

se conservan como redirecciones locales hacia los nombres canónicos.
