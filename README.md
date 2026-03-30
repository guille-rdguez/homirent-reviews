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

Para probarlo desde otro dispositivo en la misma red:

```bash
npm run dev:public
```

## Deploy en Netlify

1. Entra a Netlify.
2. Crea un nuevo sitio desde carpeta o arrastra este directorio.
3. Publica la raíz del proyecto.
4. El sitio quedará listo sin build adicional.

Rutas principales en producción:

- `/`
- `/form.html`
- `/dashboard.html`

## Notas

- No hace falta `npm install`.
- No hace falta bundler.
- El proyecto consume Supabase vía REST, así que necesita internet para leer y guardar datos reales.
- El dashboard tiene protección simple en frontend. Antes de exponerlo fuera del equipo, conviene migrarlo a autenticación real.

## Compatibilidad

Los archivos descargados con nombres temporales:

- `2-formulario-huespedes (1).html`
- `3-dashboard-interno (1).html`

se conservan como redirecciones locales hacia los nombres canónicos.
