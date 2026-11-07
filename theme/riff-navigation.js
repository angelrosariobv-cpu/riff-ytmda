/* ============================================================
   RIFF NAVIGATION for YT Music Desktop
   Runs inside the music.youtube.com webview (injected by the
   custom-javscript integration, see custom-javascript/index.ts).

   Two jobs:
   1. AMBIENT ALBUM ART — feeds --riff-album-art (used by
      riff-theme.css ::before blurred layer) from the art in the
      player bar, updating on every song change.
   2. PAGE TRANSITIONS — adds .riff-page-enter to the section
      list on every navigation so riff-theme.css' keyframes run.
   ============================================================ */

(function () {
  'use strict';

  /* ---------------------------------------------------------
     1. Ambient album art
     --------------------------------------------------------- */
  let lastArt = '';

  function extractArtFromNode(root) {
    if (!root || !root.querySelector) return '';
    // Candidatos de portada, priorizando la de mayor resolución.
    const sel = [
      'ytmusic-player-bar #song-image img',
      '#song-image img',
      'ytmusic-player-bar img.image',
      'ytmusic-player-bar yt-img img',
      'ytmusic-player-bar img',
    ];
    let src = '';
    for (const s of sel) {
      try {
        const el = root.querySelector(s);
        if (el) {
          src = el.currentSrc || el.src || '';
          if (src) break;
        }
      } catch (_) {}
    }
    return src;
  }

  function setAmbientArt(url) {
    if (!url || url === lastArt) return;
    lastArt = url;
    // Bump only if the URL requests fewer than 800px; keep 544/1080 as-is.
    const m = url.match(/=w(\d+)-h(\d+)/);
    let big = url;
    if (m && parseInt(m[1], 10) < 800) {
      big = url.replace(/=w\d+-h\d+[^=]*$/, '=w1600-h1600-l90-rj');
    }
    try {
      document.documentElement.style.setProperty('--riff-album-art', `url("${big}")`);
    } catch (_) {}
    computeAccentFromArt(url);
  }

  /* Color dominante de la portada => accent de las barras del visualizer
     (Creating the Rubicon rojo, Swedish Pagans morado, ...)
     Página: intento por crossOrigin/blob (por si algún día CORS abre).
     Determinista: el proceso MAIN descarga sin CORS y llama a
     window.__riffProcessAccent(dataURL) con la misma imagen en base64. */
  function processImageToAccent(img) {
    try {
      const c = document.createElement('canvas');
      c.width = 8; c.height = 8;
      const cx = c.getContext('2d', { willReadFrequently: true });
      cx.drawImage(img, 0, 0, 8, 8);
      const d = cx.getImageData(0, 0, 8, 8).data;
      const buckets = {};
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const sat = max - min;
        if (sat < 40) continue; // descarta grises, beis y humo aan Zurich
        const key = (r >> 4) + '_' + (g >> 4) + '_' + (b >> 4);
        const e = buckets[key] || (buckets[key] = { rs: 0, gs: 0, bs: 0, n: 0, satsum: 0 });
        e.rs += r; e.gs += g; e.bs += b; e.n += 1; e.satsum += sat;
      }
      // El mas LLAMATIVO del COVER GLOBAL, no del recorte mas caliente:
      // score = saturacion^1.2 * area. (con sat^2 el naranja de las
      // explosiones ganaba SIEMPRE aunque el cover sea verde/azul.)
      let best = null, bestScore = -1;
      for (const k in buckets) {
        const e = buckets[k];
        const avgSat = e.satsum / e.n;
        const score = Math.pow(avgSat, 1.2) * e.n;
        if (score > bestScore) { bestScore = score; best = e; }
      }
      if (best) {
        let r = Math.round(best.rs / best.n), g = Math.round(best.gs / best.n), b = Math.round(best.bs / best.n);
        const lift = 1.25;
        r = Math.min(255, Math.round(r * lift));
        g = Math.min(255, Math.round(g * lift));
        b = Math.min(255, Math.round(b * lift));
        window.__riffAccent = { r: r, g: g, b: b };
        try {
          // Glow ALIGERADO (mezcla 45% hacia blanco): si el glow igualara
          // al accent se camuflaria con el ambiente, que es la misma
          // portada oscurecida. Mas claro => resalta siempre.
          const gl = 0.45;
          const rr = Math.round(r + (255 - r) * gl);
          const gg = Math.round(g + (255 - g) * gl);
          const bb = Math.round(b + (255 - b) * gl);
          document.documentElement.style.setProperty('--riff-accent', 'rgb(' + r + ',' + g + ',' + b + ')');
          document.documentElement.style.setProperty('--riff-accent-glow', 'rgba(' + rr + ',' + gg + ',' + bb + ',0.6)');
          // AMBIENTE SOLID: gradiente construido con el color dominante.
          // Los gradientes CSS son uniformes por diseño — el "split"
          // interno del arte del disco ya no puede partir la mitad.
          const amb1 = 'rgba(' + Math.round(r * 1.15) + ',' + Math.round(g * 1.15) + ',' + Math.round(b * 1.15) + ',0.9)';
          const amb2 = 'rgba(' + Math.round(r * 0.6) + ',' + Math.round(g * 0.6) + ',' + Math.round(b * 0.6) + ',0.75)';
          const amb3 = 'rgba(' + Math.round(r + (255 - r) * 0.4) + ',' + Math.round(g + (255 - g) * 0.4) + ',' + Math.round(b + (255 - b) * 0.4) + ',0.5)';
          const solid = 'radial-gradient(ellipse at 22% 18%, ' + amb1 + ', rgba(0,0,0,0) 72%)'
            + ', radial-gradient(ellipse at 82% 88%, ' + amb3 + ', rgba(0,0,0,0) 70%)'
            + ', linear-gradient(160deg, ' + amb2 + ', rgba(8,8,10,0.92) 82%)';
          document.documentElement.style.setProperty('--riff-ambient-solid', solid);
          window.__riffAccentLog = 'rgb(' + r + ',' + g + ',' + b + ')';
        } catch (_) {}
      } else {
        // Sin bucket saturado => cover blanco/gris (el placeholder
        // morado Riff saltaba). Pedido 2026-11-07: gris claro #c7c8ca.
        // OJO: NO tocar __riffGlowCssKey aqui — el draw-loop debe
        // detectar el key nuevo y reconstruir el ambiente con el gris
        // (puse la key a mano y el fondo se quedaba con el gradiente
        // de la cancion anterior).
        const R = 199, G = 200, B = 202;
        window.__riffAccent = { r: R, g: G, b: B };
        try {
          document.documentElement.style.setProperty('--riff-accent', 'rgb(' + R + ',' + G + ',' + B + ')');
          document.documentElement.style.setProperty('--riff-accent-glow', 'rgba(' + Math.round(R + (255 - R) * 0.45) + ',' + Math.round(G + (255 - G) * 0.45) + ',' + Math.round(B + (255 - B) * 0.45) + ',0.6)');
          applyPrimaryColorToBar('rgb(' + R + ',' + G + ',' + B + ')');
          window.__riffAccentLog = 'rgb(' + R + ',' + G + ',' + B + ')';
        } catch (_) {}
      }
    } catch (_) {
      window.__riffAccent = window.__riffAccent || null;
    }
  }

  // API para el proceso main: le llega la portada como data URL (untainted)
  window.__riffProcessAccent = function (dataUrl) {
    try {
      const img = new Image();
      img.onload = () => processImageToAccent(img);
      img.onerror = () => {};
      img.src = dataUrl;
    } catch (_) {}
  };

  function computeAccentFromArt(url) {
    if (!url) return;
    const viaBlob = () => {
      try {
        fetch(url)
          .then((r) => r.blob())
          .then((blob) => {
            const img = new Image();
            img.onload = () => processImageToAccent(img);
            img.onerror = () => { window.__riffAccent = window.__riffAccent || null; };
            img.src = URL.createObjectURL(blob);
          })
          .catch(() => { window.__riffAccent = window.__riffAccent || null; });
      } catch (_) { window.__riffAccent = window.__riffAccent || null; }
    };

    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => processImageToAccent(img);
      img.onerror = viaBlob;
      img.src = url;
    } catch (_) { viaBlob(); }
  }

  /* ¿Arte UTILIZABLE? Descarta placeholders: vacios, data URIs (el
     gif 1x1 de YTM para tracks sin album-art) y thumnbails vacias. */
  function isUsableArt(u) {
    if (!u || typeof u !== 'string') return false;
    const t = u.trim();
    if (!t) return false;
    if (t.startsWith('data:')) {
      // data:image/gif;base64,R0lGOD... = placeholder YTM 1x1
      return false;
    }
    return true;
  }

  /* FALLBACK ASTRO PARA MUSICA-VIDEO: los videoclips no traen
     album-art (#song-image queda con el gif 1x1) — el sistema
     dejaba el color por defecto (morado Riff) secuestrando la
     titlebar. Miniatura del video: item seleccionado de la cola y
     —ultimo recurso— CUALQUIER img >= 48x48 visible dentro del
     player-page con src real (el DOM de YT cambia con frecuencia;
     el fallback generico no se rompe). */
  function findVideoThumb() {
    const sels = [
      'ytmusic-player-queue-item[aria-selected="true"] img',
      'ytmusic-player-queue-item[aria-selected] img',
      'ytmusic-player-queue .ytmusic-player-queue-item[selected] img',
      'ytmusic-player-queue ytmusic-player-queue-item img',
      'ytmusic-player .ytmusic-player-queue img',
      '#player-page ytmusic-responsive-list-item-renderer[aria-selected] img',
      '#player-page ytmusic-responsive-list-item-renderer img'
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) {
        const u = el.currentSrc || el.src || '';
        if (isUsableArt(u)) return u;
      }
    }
    try {
      const page = document.querySelector('ytmusic-player-page') || document;
      const imgs = page.querySelectorAll('img');
      for (const el of imgs) {
        const u = el.currentSrc || el.src || '';
        if (!isUsableArt(u)) continue;
        const r = el.getBoundingClientRect();
        if (r.width >= 48 && r.height >= 48) return u;
      }
    } catch (_) {}
    return '';
  }

  function scanForArt() {
    // PRIORIDAD 1: el cover GRANDE del player-page (`#song-image`) —
    // la fuente confiable que SIEMPRE trae el cover de la cancion
    // actual. El player-bar guarda un <img> oculto con el cover
    // ANTERIOR (el lag infamous del ambient y los colores).
    let art = '';
    const songImg = document.querySelector('#song-image img');
    if (songImg) {
      const u = songImg.currentSrc || songImg.src || '';
      if (isUsableArt(u)) art = u;
    }
    // Fallback musico-video: la miniatura del video actua de cover
    // ( alimenta TODOS los sistemas: ambient, titlebar, EQ panel).
    if (!art) art = findVideoThumb();
    // Fallback final: el bar
    if (!art) {
      const bar = document.querySelector('ytmusic-player-bar');
      if (bar) {
        const u = extractArtFromNode(bar);
        if (isUsableArt(u)) art = u;
      }
    }
    if (art) setAmbientArt(art);
  }

  const artObserver = new MutationObserver(() => {
    // La barra de YT actualiza title antes que la imagen: re-escaneamos
    // varias veces para no fijar la portada de la canción ANTERIOR.
    scanForArt();
    setTimeout(scanForArt, 250);
    setTimeout(scanForArt, 800);
    setTimeout(scanForArt, 1800);
  });
  // YT reemplaza NODOS de imagen (no solo el attr src): childList neces.
  const artConfig = { attributes: true, attributeFilter: ['src'], subtree: true, childList: true };
  const artTimer = setInterval(() => {
    const bar = document.querySelector('ytmusic-player-bar');
    if (bar) {
      artObserver.observe(bar, artConfig);
      clearInterval(artTimer);
      scanForArt();
    }
  }, 250);

  /* ---------------------------------------------------------
     2. Page transitions
     --------------------------------------------------------- */
  function wantsTransition(mainContent) {
    return !!mainContent;
  }

  function triggerPageEnter(mainContent) {
    if (!mainContent) return;
    // Restart the CSS animation on the page container.
    const page =
      mainContent.querySelector('ytmusic-page-renderer') ||
      mainContent.querySelector('ytmusic-section-list-renderer');
    if (!page) return;
    page.classList.remove('riff-page-enter');
    // Force reflow so removing/adding re-starts in one frame.
    void page.offsetWidth;
    page.classList.add('riff-page-enter');
  }

  function bindContentObserver() {
    const host = document.querySelector('#main-content, ytmusic-browse, #browse') || document;
    const mut = new MutationObserver(() => {
      triggerPageEnter(document.querySelector('#main-content') || document);
    });
    mut.observe(host, { childList: true, subtree: true });
    triggerPageEnter(document.querySelector('#main-content') || document);
  }

  // YTM builds its container async; wait for a stable hook.
  const navTimer = setInterval(() => {
    const mainContent = document.querySelector('#main-content');
    if (wantsTransition(mainContent)) {
      clearInterval(navTimer);
      bindContentObserver();
    }
  }, 250);

  /* ---------------------------------------------------------
     3. Long-verse guard — estrofas muy largas no deben comerse
        los bordes: marcamos la linea activa con .riff-long-line
        y el CSS la reduce. Se vigila el panel de letras con un
        MutationObserver ligero (solo cambios de clase/atributo).
     --------------------------------------------------------- */
  const LONG_LINE_LIMIT = 55; // caracteres aproximados del ancho seguro en 2 líneas

  function wireLongVerseGuard() {
    const root =
      document.querySelector('.ytmusic-description-shelf-renderer') ||
      document.querySelector('.ytmd-lyrics') ||
      document.querySelector('ytmusic-player-page #tab-renderer');
    if (!root || root.__riffLongVerseWired) return;

    const update = () => {
      const active =
        root.querySelector('[active]') ||
        root.querySelector('.active') ||
        root.querySelector('.ytmd-lyric-line.active');
      if (!active) return;
      const len = (active.textContent || '').trim().length;
      active.classList.toggle('riff-long-line', len > LONG_LINE_LIMIT);
    };

    const debounced = () => {
      clearTimeout(root.__riffLongVerseTimer);
      root.__riffLongVerseTimer = setTimeout(update, 140);
    };

    const obs = new MutationObserver(debounced);
    obs.observe(root, { attributes: true, attributeFilter: ['class', 'active'], subtree: true, childList: true });
    root.__riffLongVerseWired = true;
    update();
  }

  // Re-wire cuando cambia la página (el panel de letras se recrea).
  const longVerseTimer = setInterval(wireLongVerseGuard, 1500);
  setTimeout(() => clearInterval(longVerseTimer), 60000);
  wireLongVerseGuard();

  // Auto-curación global: re-scan de portada cada 2s (por si YT muda el
  // nodo desde otro camino que el observer no vea). Sin límite duro de
  // 10 min para sesiones largas, luego sigue menos denso.
  const healTimer = setInterval(scanForArt, 2000);
  setTimeout(() => clearInterval(healTimer), 600000);

  // Scrim buster: cada 1.5s fuerza el ocultamiento del overlay nativo
  // .background-gradient (si YTM lo re-pinta inline con !important,
  // la regla CSS pierde pero visibility inline gana el último turno).
  // NOTA: ytmusic-custom-index-landing-page NUNCA aquí — es la home
  // entera (ocultarla borra todas las canciones).
  // Epoch: matar el buster de inyecciones anteriores (si no, el intervalo
  // zombi de 12 min sigue ocultando la home tras un hot-reload).
  if (window.__riffScrimBuster) clearInterval(window.__riffScrimBuster);
  /* SCRIM BUSTER SUSPENDIDO (bisect 2026-11-06): con el CSS ya matando
     el scrim (.background-gradient visibility:hidden) el buster es
     redundante, y las mutaciones inline cada 1.5s sobre los contenedores
     del layout corren el riesgo de pelear con el render incremental de
     Polymer (canciones desaparecidas correlacionadas con este ciclo).
     Si hay que reactivarlo: des-comentar. */
  /*
  const scrimBuster = setInterval(() => {
    try {
      document.querySelectorAll('.background-gradient').forEach((el) => {
        el.style.setProperty('visibility', 'hidden', 'important');
        el.style.setProperty('background', 'transparent', 'important');
        el.style.setProperty('background-image', 'none', 'important');
      });
      document.querySelectorAll('#nav-bar-background, #mini-guide-background').forEach((nav) => {
        nav.style.setProperty('background', 'transparent', 'important');
      });
    } catch (_) {}
  }, 1500);
  setTimeout(() => clearInterval(scrimBuster), 720000);
  window.__riffScrimBuster = scrimBuster;
  */

  // Safety unbinds for long sessions.
  setTimeout(() => clearInterval(artTimer), 30000);
  setTimeout(() => clearInterval(navTimer), 30000);

  // Safety unbinds for long sessions.

  /* Fuerza el color primario sobre la barra nativa (barra serpenteante
     + fallback de variables): var global + propiedad nativa de YTM */
  function applyPrimaryColorToBar(colorHex) {
    document.documentElement.style.setProperty('--riff-primary-color', colorHex);
    const progressBar = document.querySelector('#progress-bar');
    if (progressBar) {
      progressBar.style.setProperty('--paper-progress-active-color', colorHex, 'important');
    }
  }

  /* --- Onda de periodo fijo: la sincroniza el DRAW del visualizador
     cada rAF (polymer estira con scaleX; publicamos el width exacto,
     transform se anula via CSS). Sin interval = sin parpadeo. ---
     (El interval initRiffWaveSizing fue reemplazado por el bloque
     wave-sync dentro del draw del visualizador.) --- */

  /* ---------------------------------------------------------
     4. RIFF AUDIO VISUALIZER (Fase 2) — epoch tokens: cada
        re-inyeccion del script mata los loops viejos, recicla el
        analyser (MediaElementSource solo conecta UNA vez) y
        reconstruye el canvas dentro de la player bar:
        background < barras (z:-1) < controles.
     --------------------------------------------------------- */
  (function initRiffVisualizerModule() {
    const ENABLED = true;
    if (!ENABLED) return;
    window.__riffVisEpoch = (window.__riffVisEpoch || 0) + 1;
    const epoch = window.__riffVisEpoch;
    // Re-inyeccion = reinicio limpio del boot (el viejo guard bloqueaba,
    // dejando el canvas CONGELADO: el "caja translucida" era ese frame).
    window._riffVisInitialized = false;
    if (window.__riffVisBootTimer) clearInterval(window.__riffVisBootTimer);
    window.__riffVisEpochBooted = 0;

    function boot() {
      if (window.__riffVisEpochBooted === epoch) return;
      const videoElem = document.querySelector('video');
      const playerBar = document.querySelector('ytmusic-player-bar');
      if (!videoElem || !playerBar) return;

      // Limpieza de canvases fuera de la barra (boots viejos en body)
      document.querySelectorAll('#riff-audio-visualizer').forEach((c) => {
        if (c.parentElement !== playerBar) c.remove();
      });

      // Canvas: dentro de la barra, primer hijo (z-index:-1 => pinta
      // sobre el fondo de la barra y debajo de los controles).
      let canvas = document.getElementById('riff-audio-visualizer');
      if (!canvas || !canvas.parentElement || !canvas.parentElement.matches('ytmusic-player-bar')) {
        canvas = document.createElement('canvas');
        canvas.id = 'riff-audio-visualizer';
        canvas.style.cssText = 'position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; opacity:0.1; z-index:-1;';
        playerBar.insertBefore(canvas, playerBar.firstChild);
      }
      // Re-aplica SIEMPRE el estilo (el hot-reload no afecta los
      // canvases reutilizados de boots anteriores) — la "caja" que
      // seguia igual tenia opacity vieja pegada.
      canvas.style.cssText = 'position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; opacity:0.1; z-index:-1;';
      const ctx = canvas.getContext('2d');
      playerBar.style.position = 'relative';

      // Analyser + AudioContext AMBOS referenciados: si el AudioContext
      // cae en GC, el analyser deja de entregar datos (barras vacias).
      if (!window.__riffAnalyser || !window.__riffAudioCtx || !window.__riffSource) {
        try {
          const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          window.__riffAudioCtx = audioCtx;
          const source = audioCtx.createMediaElementSource(videoElem);
          window.__riffSource = source;
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 64;
          window.__riffEQWired = false; // el EQ se re-daisy-chainea si aun no
          source.connect(analyser);
          analyser.connect(audioCtx.destination);
          videoElem.addEventListener('play', () => {
            const actx = window.__riffAudioCtx;
            if (actx && actx.state === 'suspended') { try { actx.resume(); } catch (_) {} }
          });
          window.__riffAnalyser = analyser;
        } catch (e) {
          console.warn('Riff Visualizer: AudioContext ya conectado o bloqueado por CORS', e);
          clearInterval(bootTimer);
          return;
        }
      }

      const analyser = window.__riffAnalyser;
      const actx = window.__riffAudioCtx;
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      function draw() {
        if (epoch !== window.__riffVisEpoch) return; // epoch nuevo: muere
        requestAnimationFrame(draw);
        if (!canvas.isConnected) return;
        if (canvas.width !== playerBar.clientWidth) canvas.width = playerBar.clientWidth;
        if (canvas.height !== playerBar.clientHeight) canvas.height = playerBar.clientHeight;

        // Revive el contexto si YT lo pauso (autoplay policy)
        if (actx && actx.state === 'suspended') {
          try { actx.resume(); } catch (_) {}
        }

        analyser.getByteFrequencyData(dataArray);
        const accent = window.__riffAccent;

        // --- WAVE FLOW: la onda nadа (gif), mask-position por rAF ---
        try {
          const pbar2 = playerBar.querySelector('#progress-bar #sliderBar');
          const primF = pbar2 && pbar2.querySelector('#primaryProgress');
          if (primF) {
            const off = -(((performance.now() / 1000) * 16) % 40); // 16px/s, loop 40px
            primF.style.setProperty('-webkit-mask-position', off.toFixed(2) + 'px center', 'important');
            primF.style.setProperty('mask-position', off.toFixed(2) + 'px center', 'important');
          }
        } catch (_) {}

        // Wave width sync (periodo fijo) en este mismo frame: sin parpadeo
        try {
          const pbar = playerBar.querySelector('#progress-bar #sliderBar');
          const prim = pbar && pbar.querySelector('#primaryProgress');
          if (prim) {
            const styleAttr = prim.getAttribute('style') || '';
            const mX = styleAttr.match(/scaleX\(\s*([\d.]+)\s*\)/);
            let fracA = mX ? parseFloat(mX[1]) : null;
            if (fracA === null || !isFinite(fracA)) {
              const t0 = getComputedStyle(prim).transform;
              if (t0 && t0 !== 'none') {
                const mm = t0.match(/matrix\(([^)]+)\)/);
                if (mm) fracA = parseFloat(mm[1].split(',')[0]);
              }
            }
            if (fracA !== null && isFinite(fracA)) {
              fracA = Math.max(0, Math.min(1, fracA));
              const targetW = Math.round(pbar.clientWidth * fracA);
              if (window.__riffWaveW !== targetW) {
                window.__riffWaveW = targetW;
                prim.style.setProperty('width', targetW + 'px', 'important');
              }
            }
          }
        } catch (_) {}

        if (accent && accent.r !== undefined) {
          const key = accent.r + '_' + accent.g + '_' + accent.b;
          if (window.__riffGlowCssKey !== key) {
            window.__riffGlowCssKey = key;
            const gl = 0.45;
            const rr = Math.round(accent.r + (255 - accent.r) * gl);
            const gg = Math.round(accent.g + (255 - accent.g) * gl);
            const bb = Math.round(accent.b + (255 - accent.b) * gl);
            try {
              document.documentElement.style.setProperty('--riff-accent', 'rgb(' + accent.r + ',' + accent.g + ',' + accent.b + ')');
              document.documentElement.style.setProperty('--riff-accent-glow', 'rgba(' + rr + ',' + gg + ',' + bb + ',0.6)');
              applyPrimaryColorToBar('rgb(' + accent.r + ',' + accent.g + ',' + accent.b + ')');
              // AMBIENTE SOLID reconstruido AQUI (accent vivo): es la unica
              // pieza que no se re-publicaba — la franja superior quedaba
              // con el color de la cancion ANTERIOR.
              const a1 = 'rgba(' + Math.round(accent.r * 1.15) + ',' + Math.round(accent.g * 1.15) + ',' + Math.round(accent.b * 1.15) + ',0.9)';
              const a2 = 'rgba(' + Math.round(accent.r * 0.6) + ',' + Math.round(accent.g * 0.6) + ',' + Math.round(accent.b * 0.6) + ',0.75)';
              const a3 = 'rgba(' + rr + ',' + gg + ',' + bb + ',0.5)';
              const solid = 'radial-gradient(ellipse at 22% 18%, ' + a1 + ', rgba(0,0,0,0) 72%)'
                + ', radial-gradient(ellipse at 82% 88%, ' + a3 + ', rgba(0,0,0,0) 70%)'
                + ', linear-gradient(160deg, ' + a2 + ', rgba(8,8,10,0.92) 82%)';
              document.documentElement.style.setProperty('--riff-ambient-solid', solid);
              // FIX GEMINI (boot fallback): ademas de la var, pintar el
              // GRADIENTE DIRECTO inline en ytmusic-app (sin indireccion
              // de var) — si el ::before esta leyendo una var obsoleta
              // del boot, el background del ELEMENTO mismo tapa con el
              // color correcto. Y limpiar inline stale de navs.
              try {
                const appEl = document.querySelector('ytmusic-app');
                if (appEl) appEl.style.background = solid;
                // Doble blindaje: pintar los contenedores de la franja
                // superior DIRECTO con el gradiente del accent — la franja
                // deja de depender de capas globales/herencias.
                document.querySelectorAll('#nav-bar-background, #mini-guide-background').forEach((nav) => {
                  if (nav) {
                    nav.style.setProperty('background', solid, 'important');
                  }
                });
              } catch (_) {}
              try {
                document.querySelectorAll('#nav-bar-background, #mini-guide-background, #header-background').forEach((nav) => {
                  if (nav) nav.style.setProperty('background', 'transparent', 'important');
                });
              } catch (_) {}
              window.__riffAccentLog = 'rgb(' + accent.r + ',' + accent.g + ',' + accent.b + ')';
            } catch (_) {}
          }
        }

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const accentOk = accent && accent.r !== undefined;
        ctx.fillStyle = accentOk
          ? 'rgba(' + accent.r + ',' + accent.g + ',' + accent.b + ',0.9)'
          : 'rgba(255, 255, 255, 0.6)';
        const barWidth = (canvas.width / bufferLength) * 1.5;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
          // Altura limitada al 70% del canvas: deja aire arriba y no invade
          const barHeight = (dataArray[i] / 255) * canvas.height * 0.7;
          ctx.fillRect(x, canvas.height - barHeight, barWidth - 2, barHeight);
          x += barWidth + 1;
        }
      }

      draw();
      window.__riffVisEpochBooted = epoch;
      window._riffVisInitialized = true;
      clearInterval(bootTimer);
    }

    const bootTimer = setInterval(boot, 1500);
    window.__riffVisBootTimer = bootTimer;
    boot();
  })();

  /* ---------------------------------------------------------
     5. TRANSICIONES DE SECCION (Fase 2/Gemini) — reinicia la
        animacion riffSectionEnter en cada navegacion de YT.
     --------------------------------------------------------- */
  (function initRiffTransitions() {
    function triggerTransition() {
      const mainView = document.querySelector('ytmusic-browse-response, #browse-page, ytmusic-search-page');
      if (mainView) {
        mainView.classList.remove('riff-page-transition');
        void mainView.offsetWidth; // reflow para reiniciar el keyframe
        mainView.classList.add('riff-page-transition');
      }
      // Sidebar: re-dispara el stagger de las entradas
      const g = document.querySelector('ytmusic-guide-renderer');
      if (g) {
        g.classList.remove('riff-guide-restart');
        void g.offsetWidth;
        g.classList.add('riff-guide-restart');
      }
    }
    document.addEventListener('yt-navigate-finish', triggerTransition);
    document.addEventListener('yt-page-data-updated', triggerTransition);
  })();

  /* ---------------------------------------------------------
     6. TRANSICIONES EN TABS DEL PLAYER (Gemini, COMPLETO):
        solo tabs internas con click. Las animaciones sobre el
        ytmusic-player-page (expandir/minimizar) QUEDARON FUERA:
        con animation fill 'forwards' se quedaba "atornillada" la
        pagina del player (overlay fixed) y no colapsaba.
     --------------------------------------------------------- */
  (function initRiffPlayerTransitions() {
    document.addEventListener('click', (e) => {
      const tabBtn = e.target.closest && e.target.closest('tp-yt-paper-tab, .tab-header, [role="tab"]');
      if (tabBtn) {
        setTimeout(() => {
          const tabContent = document.querySelector('#tab-renderer, ytmusic-tab-renderer');
          if (tabContent) {
            tabContent.classList.remove('riff-animating-tab');
            void tabContent.offsetWidth;
            tabContent.classList.add('riff-animating-tab');
          }
        }, 50);
      }
    });
  })();

  /* ---------------------------------------------------------
     7. RIFF EQUALIZER (Fase 3) — 10 bandas Biquad daisy-chained
        EN la WebAudio chain del visualizer (source→filters→analyser);
        panel UI flotante (Shift+E abre/cierra), gains persistidos.
        Reutiliza la MISMA conexion (MediaElementSource es singleton).
     --------------------------------------------------------- */
  (function initRiffEqualizer() {
    const ENABLED = true;
    if (!ENABLED || window.__riffEQModuleBooted) return;
    window.__riffEQModuleBooted = true;

    const FREQS = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];
    const LABELS = ['60', '170', '310', '600', '1k', '3k', '6k', '12k', '14k', '16k'];
  /* Tooltips humanos del EQ — sin jerga tecnica, de que hace cada banda */
  const EQ_HINTS = [
    'Lo mas grave: el "boombajo" de la bateria. Subelo si la musica suena sin cuerpo, bajalo si tronea mucho.',
    'El golpe del bajo. Subelo si el bajo se escucha tenue, bajalo si te aturde.',
    'El cuerpo de guitarras y voces. Bajalo un poco si suena opaco o "en caja".',
    'Zona de la mezcla que suele tapar el resto. Bajala si las voces pierden claridad.',
    'El corazon de las voces. Subela poco para presentes, no exageres.',
    'Claridad y detalle de lo que se canta y toca. Subela si te cuesta entender las letras.',
    'Destello de la bateria y nitidez de las voces. Subela si suenan sordas, bajala si danas tus oidos.',
    'Brillo general. Subelo para que suene mas limpio, bajalo si suena hacia "chisporroteo".',
    'El aire mas fino. Sutil: subelo un poco para brillo extra.',
    'El agudo extremo que tus audifonos casi no reproducen. Subelo para ganar brillo terminal.',
  ];

    function loadGains() {
      try {
        const g = JSON.parse(localStorage.getItem('riff_eq_gains_v1') || 'null');
        return Array.isArray(g) && g.length === FREQS.length ? g : null;
      } catch (_) { return null; }
    }
    const gains = loadGains() || Array(FREQS.length).fill(0);

    /* Re-wiring: source → 10 filtros → analyser (una sola vez) */
    const wireTimer = setInterval(() => {
      const src = window.__riffSource;
      const ctx = window.__riffAudioCtx;
      const an = window.__riffAnalyser;
      if (!src || !ctx || !an) return;

      try {
        if (window.__riffEQWired) {
          clearInterval(wireTimer);
          return;
        }
        window.__riffEQFilters = FREQS.map((f, i) => {
          const fb = ctx.createBiquadFilter();
          fb.type = 'peaking';
          fb.frequency.value = f;
          fb.Q.value = 1.1;
          fb.gain.value = (gains[i] || 0);
          return fb;
        });
        try { src.disconnect(); } catch (_) {}
        let prev = src;
        window.__riffEQFilters.forEach((fb) => { prev.connect(fb); prev = fb; });
        prev.connect(an);
        window.__riffEQWired = true;
        buildPanel();
        clearInterval(wireTimer);
      } catch (e) {
        console.warn('[RiffEQ] wiring failed:', e);
        clearInterval(wireTimer);
      }
    }, 800);
    setTimeout(() => clearInterval(wireTimer), 120000);

    /* ---- PANEL UI (TrustedHTML-safe: createElement + textContent,
          sin innerHTML — YTM bloquea innerHTML por Trusted Types) ---- */
    function buildPanel() {
      if (document.getElementById('riff-eq-panel')) return;
      const mk = (tag, css, txt) => {
        const el = document.createElement(tag);
        if (css) el.style.cssText = css;
        if (txt !== undefined) el.textContent = txt;
        return el;
      };
      const panel = mk('div', 'position:fixed; right:18px; bottom:110px; width:340px; max-height:60vh; overflow-y:auto; display:none; z-index:999; padding:14px 16px; border-radius:16px; background:rgba(18,18,20,0.92); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px); border:1px solid rgba(255,255,255,0.08); color:#E6E6E8; font-family:sans-serif; box-shadow:0 8px 32px rgba(0,0,0,0.5);');
      panel.id = 'riff-eq-panel';
      const accent = (window.__riffAccent) ? 'rgb(' + window.__riffAccent.r + ',' + window.__riffAccent.g + ',' + window.__riffAccent.b + ')' : '#5247d1';
      const head = mk('div', 'display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;');
      head.appendChild(mk('span', 'font-size:13px; font-weight:600; color:' + accent + '; letter-spacing:0.05em;', 'RIFF EQ'));
      const btns = mk('div', 'display:flex; gap:6px;');
      const reset = mk('button', 'background:rgba(255,255,255,0.08); border:0; color:#E6E6E8; padding:3px 10px; border-radius:999px; font-size:11px; cursor:pointer;', 'Reset');
      const close = mk('button', 'background:rgba(255,255,255,0.08); border:0; color:#E6E6E8; padding:3px 10px; border-radius:999px; font-size:11px; cursor:pointer;', '✕');
      btns.appendChild(reset); btns.appendChild(close);
      head.appendChild(btns);
      panel.appendChild(head);
      LABELS.forEach((lbl, i) => {
        const row = mk('div', 'display:flex; align-items:center; gap:10px; margin-bottom:6px;');
        const labelEl = mk('span', 'width:44px; font-size:11px; color:rgba(255,255,255,0.55); cursor:help;', lbl);
        /* Tooltip en lenguaje humano: que hace esa banda sin jerga */
        labelEl.title = EQ_HINTS[i] || '';
        row.appendChild(labelEl);
        const input = mk('input', 'flex:1; accent-color:' + accent + ';');
        input.type = 'range';
        input.dataset.eqIdx = String(i);
        input.min = '-12'; input.max = '12'; input.step = '1';
        input.value = String(gains[i] || 0);
        const val = mk('span', 'width:38px; text-align:right; font-size:11px; color:rgba(255,255,255,0.4);');
        val.dataset.eqVal = String(i);
        val.textContent = ((gains[i] || 0) > 0 ? '+' : '') + (gains[i] || 0);
        row.appendChild(input); row.appendChild(val);
        panel.appendChild(row);

        input.addEventListener('input', () => {
          const idx = parseInt(input.dataset.eqIdx, 10);
          const v = parseFloat(input.value);
          if (window.__riffEQFilters && window.__riffEQFilters[idx]) {
            try { window.__riffEQFilters[idx].gain.value = v; } catch (_) {}
          }
          gains[idx] = v;
          val.textContent = (v > 0 ? '+' : '') + v;
          try { localStorage.setItem('riff_eq_gains_v1', JSON.stringify(gains)); } catch (_) {}
        });
      });
      reset.addEventListener('click', () => {
        gains.fill(0);
        try { localStorage.setItem('riff_eq_gains_v1', JSON.stringify(gains)); } catch (_) {}
        panel.querySelectorAll('input[data-eq-idx]').forEach((input) => {
          input.value = '0';
          const idx = parseInt(input.dataset.eqIdx, 10);
          if (window.__riffEQFilters && window.__riffEQFilters[idx]) {
            try { window.__riffEQFilters[idx].gain.value = 0; } catch (_) {}
          }
          const valEl = panel.querySelector('[data-eq-val="' + idx + '"]');
          if (valEl) valEl.textContent = '0';
        });
      });
      close.addEventListener('click', () => {
        panel.style.display = 'none';
      });
      document.body.appendChild(panel);
    }

    /* Hotkey: Shift+E abre/cierra el panel */
    window.addEventListener('keydown', (e) => {
      if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
      if (e.code === 'KeyE') {
        e.preventDefault();
        e.stopPropagation();
        const panel = document.getElementById('riff-eq-panel');
        if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        else if (window.__riffEQWired) buildPanel();
      }
    }, true);
  })();
})();
