# Parches YTMDA (fork dev) — integración completa

Qué hay que tocar en el código fuente de YTMDA para que TODO funcione (colores dinámicos, titlebar reactiva, EQ). Son 4 toques pequeños; el resto del código del fork queda intacto.

> **Base:** rama dev de YTMDA v3 (`ytmda-g/ytmusic-desktop-app` o el fork que uses — probado en `Downloads\ytmdesktop-development`).

## 1. Copiar la integración CustomJS

Copia la carpeta `integration/custom-javascript/` de este repo a:

```
src/main/integrations/custom-javascript/
```

Es una integración nueva (no sobreescribe nada): inyecta `riff-navigation.js` en el webview de YT Music con hot-reload por fs.watch, y sincroniza el color del cover con la barra de título.

## 2. Registrarla en el main

En `src/main/index.ts`:

```ts
// imports (arriba, junto a los demás):
import CustomJS from "./integrations/custom-javascript";

// en la creación de integraciones:
integrationManager.createIntegrations([
  CustomJS,           // <-- añadir al inicio del array
  /* ...las demás que ya tengas... */
]);
```

## 3. Custom CSS con lecturas a prueba de EBUSY (opcional pero recomendado)

En `src/main/integrations/custom-css/index.ts`, dentro de `injectCSS()`, envuelve el `fs.readFileSync(cssPath, "utf8")` en un retry (el watcher puede dispararse a mitad de una escritura del archivo y crashearón de la app):

```ts
let content = "";
for (let attempt = 0; attempt < 4; attempt++) {
  try { content = fs.readFileSync(cssPath, "utf8"); break; }
  catch (e: any) {
    if (attempt === 3) { console.error("[CustomCSS] read failed after retries:", e?.message || e); return; }
    await new Promise((r) => setTimeout(r, 150));
  }
}
```

## 4. Fundido de color en la barra de título (1 línea CSS)

En `src/renderer/components/TitleBar.vue`, dentro del bloque `.titlebar`:

```css
/* junto al background-color existente */
transition: background-color 400ms cubic-bezier(0.2, 0, 0, 1);
```

---

## Config final (Settings de YTMDA)

| Ajuste | Valor |
|---|---|
| Appearance → Custom CSS enabled | ON, file = `theme/riff-theme.css` |
| Appearance → Custom CSS path | La ruta del archivo css |
| General → Hide to tray on close | ON (música sigue al cerrar la ventana) |

El archivo `theme/riff-navigation.js` se copia a:

```
%APPDATA%\YouTube Music Desktop App\custom\js\riff-navigation.js
```

## Empaquetar

```powershell
pnpm install
pnpm package
```

## Notas técnicas (por si YT Music cambia su DOM)

- El CSS se inyecta por **`document.adoptedStyleSheets`** desde el main-process, con 1.5s de delay tras `dom-ready`. Motivo: hojas añadidas por `insertCSS` o `<style>` tempranas **rompen el render incremental de las páginas browse de Polymer** (home/explore quedan colapsadas a altura 0). Si eso te pasa: revisa el canal de inyección, no el CSS.
- **No hagas mutaciones DOM repetidas por intervalo** dentro del webview de YT Music (ej. forzar estilos inline cada 1.5s): Polymer re-renderiza incrementalmente y las corridas de intervalos borran los estantes ("canciones desaparecidas"). Los kills de fondo nativo van por CSS (con `visibility`) y no por JS.
- Los placeholders de cover (track sin álbum, especialmente videoclips) traen un **GIF 1x1 data-URI**: el escáner los descarta y usa la miniatura del video desde la cola.
- YTM bloquea `innerHTML` (TrustedTypes): si agregas UI custom al webview, constrúyela con `createElement`/`textContent`.
