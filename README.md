# riff-ytmda

**Skin al estilo Riff para [YT Music Desktop App](https://github.com/ytmda-g/ytmusic-desktop-app) (YTMDA v3 / rama dev).**

Escucha YT Music con la experiencia visual de Riff: ambiente dinámico con los colores del cover que suena, barra de título que se funde con la canción, visualizador de audio, EQ de 10 bandas, karaoke, transiciones animadas y música en segundo plano al cerrar la ventana.

>Este repo **no contiene la app**: contiene la skin/sistema que se monta sobre YTMDA. Eres libre de decidir si publicas la app compilada aparte.

---

## Qué incluye

| Carpeta | Qué es |
|---|---|
| `theme/riff-theme.css` | La skin CSS completa (~900 líneas): tokens de Riff, ambiente dinámico, player bar de vidrio, sidebar, EQ, karaoke, transiciones |
| `theme/riff-navigation.js` | El motor JS que se inyecta en YT Music: escanea el cover → publica colores (`--riff-accent`, `--riff-ambient-solid`, `--riff-album-art`), visualizador + EQ WebAudio, onda de progreso, transiciones |
| `integration/custom-javascript/index.ts` | Integración main-process para YTMDA (inyecta el JS con hot-reload, sincroniza el color con la barra de título y lo reconcilia cada 2s) |
| `docs/PARCHES-YTMDA.md` | Los 4 toques pequeños al código del fork dev |

---

## Instalación rápida (solo tema, sin compilar nada)

### 1. Activa Custom CSS en YTMDA

- Abre YTMDA → **Settings → Appearance** → activa **Custom CSS**.
- Apunta al archivo `theme/riff-theme.css` de este repo (descárgalo donde lo quieras tener).

### 2. Coloca el motor JS

- Descarga `theme/riff-navigation.js` y copia en:

```
%APPDATA%\YouTube Music Desktop App\custom\js\riff-navigation.js
```

> **Nota:** la inyección automática del JS requiere el paso "instalación completa". Si tu YTMDA no tiene integración Custom JS, haz la instalación completa; si solo activas el CSS, tendrás la estática sin colores dinámicos.

---

## Instalación completa (todo: colores dinámicos, EQ, titlebar reactiva)

Requiere compilar el fork dev de YTMDA (`pnpm install && pnpm start`), Node 20+ y `pnpm`.

### 1. Aplica los 4 parches

Sigue `docs/PARCHES-YTMDA.md` — son 4 toques pequeños al código fuente de YTMDA (copiar carpeta `custom-javascript`, registrarla en `src/main/index.ts`, sombes al `custom-css` con retry EBUSY y 1 línea CSS en `TitleBar.vue`).

### 2. Coloca los archivos

- `theme/riff-navigation.js` → `%APPDATA%\YouTube Music Desktop App\custom\js\`
- Settings → Appearance → **Custom CSS** = `theme/riff-theme.css`

### 3. Empaqueta

```powershell
pnpm install
pnpm package
```

La app queda en `out\YouTube Music Desktop App-win32-x64\`.

### 4. Ajustes recomendados (Settings)

- **General: "Hide to tray on close"** → ON (cierra la ventana y la música sigue, donde dejaste los sliders del EQ)
- **Appearance → Custom CSS Enabled** = ON (registro del estilo dinámico)

---

## Shortcuts dentro de la app

| Tecla | Acción |
|---|---|
| `Shift + E` | Abre/cierra el RIFF EQ (10 bandas; los ajustes persisten) |
| Click en la portada | Abre el playlist completo |

---

## Cómo se pintan los colores

Todo el ambiente sale del cover de la canción que suena:

1. El JS escanea el cover (en videos musicales usa la miniatura del video de la cola).
2. Calcula el color dominante y construye:
   - `--riff-accent` → barra de título (con fundido de 400ms y auto-corrección cada 2s si se desincroniza)
   - `--riff-ambient-solid` → fondo completo de la app
   - `--riff-album-art` → capa de portada difuminada en la vista maximizada
3. El pipeline **nevera** y re-injecta en caliente — si editas el CSS se aplica sin reiniciar. No toques el código de `music.youtube.com` — solo skins del shell.

Sin build externa, sin dependencias nativas, sin telemetría.

---

## Créditos

- Basado en la arquitectura de YTMDA (fork dev).
- Skin inspirada en la paleta y el flow del app Riff.
- Autor: **Angel Rosario** ([@angelrosariobv-cpu](https://github.com/angelrosariobv-cpu))

## Licencia

MIT — haz lo que quieras con él (ver [LICENSE](LICENSE)).
