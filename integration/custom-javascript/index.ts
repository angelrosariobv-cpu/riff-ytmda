import fs from "fs";
import path from "path";

import { app } from "electron";

import Integration from "../integration";
import AppWindowManager from "../../services/windowmanager";

import YTMViewManager from "../../services/ytmviewmanager";

/**
 * Minimal Custom JavaScript injector for the YTM view.
 * Mirrors the built-in CustomCSS integration but executes the
 * file contents in the webview with webContents.executeJavaScript.
 *
 * Convention (no settings UI needed):
 *   put your script at:  <userData>/custom/js/riff-navigation.js
 *
 * The file is (re)injected on every dom-ready of the YTM view and
 * hot-reloads on file change. A window.__riffNavInjected guard keeps
 * the script from running twice per page.
 */
export default class CustomJS extends Integration {
  public override name = "CustomJS";
  public override storeEnableProperty: Integration["storeEnableProperty"] = "appearance.customCSSEnabled";
  public override disableFlags = ["disable_custom_css"];
  private ytmConsoleHandler: ((e: any, level: number, message: string, line?: number, sourceId?: string) => void) | null = null;
  private ytmErrorHandler: ((e: any) => void) | null = null;

  private currentWatcher: fs.FSWatcher | null = null;
  private domReadyHandler: (() => void) | null = null;
  private teardown: (() => void) | null = null;

  private ytmViewRecreatedListener = () => {
    this.teardown?.();
    this.teardown = null;
    this.hookView().catch(() => {});
  };

  public onSetup() {
    console.log(
      "[CustomJS] script path:",
      path.join(app.getPath("userData"), "custom", "js", "riff-navigation.js"),
    );
  }

  public onEnabled(): void {
    const ytmViewManager = this.getService(YTMViewManager);
    ytmViewManager.on("view-recreated", this.ytmViewRecreatedListener);
    this.hookView().catch(() => {});
    this.startAccentSync();
  }

  /* ------------------------------------------------------------
     Accent sync (Fase 2 color): lee la portada actual del renderer,
     la descarga en NODE (sin CORS), la re-empaqueta como data URL
     y la empuja a la página para window.__riffProcessAccent.
     ------------------------------------------------------------ */
  private accentTimer: NodeJS.Timeout | null = null;
  private lastAccentUrl = "";
  private titlebarReconciler: NodeJS.Timeout | null = null;

  private startAccentSync() {
    if (this.accentTimer) {
      this.startTitlebarReconciler();
      return;
    }
    this.accentTimer = setInterval(() => {
      this.syncAccentOnce().catch(() => {});
    }, 800);
    this.startTitlebarReconciler();
  }

  /* RECONCILIADOR TITLEBAR (fix barra-trabada 2026-11-07): el flujo
     normal art->process->poll podia perderse (fetch lento, stale,
     carreras) y la titlebar quedaba fijada al color del PRIMER
     cover. Este loop cada 2s compara DIRECTO el var de la pagina
     con el de la titlebar y empuja al disidente — blind e
     independiente del ciclo de art. */
  private startTitlebarReconciler() {
    if (this.titlebarReconciler) return;
    this.titlebarReconciler = setInterval(async () => {
      try {
        const ytmViewManager = this.getService(YTMViewManager);
        await ytmViewManager.ready();
        const view = ytmViewManager.getView();
        if (!view?.webContents || view.webContents.isDestroyed()) return;
        const pageAccent: string = await view.webContents.executeJavaScript(
          "getComputedStyle(document.documentElement).getPropertyValue('--riff-accent').trim() || ''",
          true,
        );
        if (!pageAccent) return;
        const appWindowManager = this.getService(AppWindowManager);
        const mainWin = appWindowManager.getWindow("Main");
        if (!mainWin?.webContents) return;
        const tbAccent: string = await mainWin.webContents.executeJavaScript(
          "getComputedStyle(document.documentElement).getPropertyValue('--riff-accent').trim() || ''",
          true,
        );
        if (pageAccent !== tbAccent) {
          await mainWin.webContents.executeJavaScript(
            `document.documentElement.style.setProperty('--riff-accent', ${JSON.stringify(pageAccent)});`,
            true,
          );
          console.log("[CustomJS] titlebar RECONCILED:", tbAccent.slice(0, 24), "->", pageAccent.slice(0, 24));
          try {
            const win = (mainWin as unknown as { _getElectronWindow(): import("electron").BrowserWindow })._getElectronWindow();
            if (typeof win.setTitleBarOverlay === "function") {
              win.setTitleBarOverlay({ color: pageAccent, symbolColor: "#FFFFFF" });
            }
          } catch (_) {}
        }
      } catch (e: any) {
        console.error("[CustomJS] reconciler failed:", e?.message || e);
      }
    }, 2000);
  }

  private async syncAccentOnce() {
    if (this.lastAccentUrl === "__pending__") return;
    const ytmViewManager = this.getService(YTMViewManager);
    await ytmViewManager.ready();
    const view = ytmViewManager.getView();
    if (!view?.webContents || view.webContents.isDestroyed()) return;
    const wc = view.webContents;

    const raw: string = await wc.executeJavaScript(
      `JSON.stringify({
        art: getComputedStyle(document.documentElement).getPropertyValue('--riff-album-art') || '',
        accent: window.__riffAccentLog || '(none)'
      })`,
      true,
    );
    let art = ""; let curAccent = "";
    try {
      const j = JSON.parse(raw);
      art = j.art || ""; curAccent = j.accent || "";
    } catch (_) { art = raw || ""; }
    const m = art.match(/url\("?([^")]+)"?\)/);
    const url = m ? m[1] : "";
    if (!url || url === this.lastAccentUrl) return;

    console.log("[CustomJS] accent sync: art ->", url.split("/").pop()?.slice(0, 45), "| push time", curAccent);

    this.lastAccentUrl = "__pending__";
    try {
      const res = await fetch(url); // Node fetch: sin restricciones CORS
      const buf = Buffer.from(await res.arrayBuffer());
      const kind = buf[0] === 0x89 ? "png" : (buf[0] === 0x52 && buf[1] === 0x49) ? "webp" : "jpeg";
      const dataUrl = `data:image/${kind};base64,${buf.toString("base64")}`;
      // COLOR EN LA PAGINA (pipeline historico — funciona: el CSP del
      // webview de YT permite data: en img-src; probado 2026-11-06:
      // push time cambia por cada cover). El intento de calcular en la
      // ventana Main (v4) NO funciona: la ventana Main tiene su propio
      // CSP que bloquea data: y https:// remotas ('load' en ambos).
      await wc.executeJavaScript(
        `window.__riffProcessAccent && window.__riffProcessAccent(${JSON.stringify(dataUrl)})`,
        true,
      );
      // Repercutir el color en la TITLEBAR (la franja superior de YTMDA
      // vive FUERA del webview de YT: se le envia el var por separado).
      // POLL corto: el processImage de la pagina es async (lee el var
      // cuando ya cambio) — 4 lecturas de 350ms = max 1.4s; en el
      // comun el primer pase ya trae el color nuevo (antes: fijas de
      // 1.2s por detras + intervalo de 3.5s = lag de hasta 5s).
      let accentVal = "";
      try {
        for (let i = 0; i < 4; i++) {
          await new Promise((r) => setTimeout(r, 350));
          accentVal = await wc.executeJavaScript(
            "getComputedStyle(document.documentElement).getPropertyValue('--riff-accent').trim() || ''",
            true,
          );
          // Listo cuando ya NO es el accent de la cancion anterior
          // (el processImage es async: el poll temprano puede leer
          // el color STALE — comparar con curAccent evita el bug del
          // titlebar clavado en el color del cover anterior).
          if (accentVal && accentVal !== curAccent) break;
        }
        if (accentVal) {
          console.log("[CustomJS] titlebar push:", accentVal.slice(0, 30));
          const appWindowManager = this.getService(AppWindowManager);
          const mainWin = appWindowManager.getWindow("Main");
          if (mainWin?.webContents) {
            await mainWin.webContents.executeJavaScript(
              `document.documentElement.style.setProperty('--riff-accent', ${JSON.stringify(accentVal)});`,
              true,
            );
            // Tambien pinta el overlay nativo de los botones de ventana
            // (min/max/close) para que la franja NO quede negra a la derecha
            try {
              const win = (mainWin as unknown as { _getElectronWindow(): import("electron").BrowserWindow })._getElectronWindow();
              if (typeof win.setTitleBarOverlay === "function") {
                win.setTitleBarOverlay({ color: accentVal, symbolColor: "#FFFFFF" });
              }
            } catch (overlayErr) {
              console.error("[CustomJS] setTitleBarOverlay failed:", overlayErr?.message || overlayErr);
            }
          }
        }
      } catch (titlebarErr) {
        console.error("[CustomJS] titlebar accent push failed:", titlebarErr?.message || titlebarErr);
      }
      // Si el accent leido sigue siendo el de la cancion ANTERIOR
      // (stale), NO marcar como procesada: el proximo ciclo (800ms)
      // reintenta la lectura hasta que llegue el color nuevo. Si
      // se marcara done aqui, el titlebar quedaria clavado para
      // siempre en el color viejo.
      if (accentVal && accentVal !== curAccent) {
        this.lastAccentUrl = url;
      } else {
        this.lastAccentUrl = "__pending__";
      }
    } catch (err: any) {
      console.error("[CustomJS] accent fetch/push FAILED:", err?.message || err);
      this.lastAccentUrl = "";
    }
  }

  public onDisabled(): void {
    const ytmViewManager = this.getService(YTMViewManager);
    if (this.accentTimer) {
      clearInterval(this.accentTimer);
      this.accentTimer = null;
    }
    ytmViewManager.off("view-recreated", this.ytmViewRecreatedListener);
    this.teardown?.();
    this.teardown = null;
    if (this.currentWatcher) {
      this.currentWatcher.close();
      this.currentWatcher = null;
    }
  }

  private async hookView() {
    // Detach from any previously hooked webContents first.
    this.teardown?.();

    const ytmViewManager = this.getService(YTMViewManager);
    await ytmViewManager.ready();
    const view = ytmViewManager.getView();
    if (!view?.webContents) return;

    const wc = view.webContents;

    const onDomReady = () => {
      if (wc.isDestroyed()) return;
      this.currentWc = wc;
      // DIFFERIDO: adoptar el CSS cuando Polymer ya termino de armar
      // su pipeline de estilos (dom-ready truncado = colapso de browse
      // probado en sesion 2026-11-06). 1.5s post-dom-ready.
      setTimeout(() => {
        if (!wc.isDestroyed()) {
          this.injectRiffCss(wc, true).catch(() => {});
        }
      }, 1500);
      this.injectNow(wc);
    };
    wc.on("dom-ready", onDomReady);
    // The view might already be past dom-ready; inject once now too.
    onDomReady();

    // CONSOLE DEL VIEW YTM -> main log (los errores de la app de YT
    // en runtime antes eran invisibles: el vite-relay solo reenvia
    // el console de la ventana Main de Vue).
    this.ytmConsoleHandler = (_e: any, level: number, message: string, line?: number, sourceId?: string) => {
      const msg = String(message || "").slice(0, 500);
      if (/^\s*\[?(\ Autofill|Fontconfig|GROUP|Fontations)/.test(msg)) return;
      console.log(`[YTMC${level}] ${msg} ${sourceId ? "@" + String(sourceId).split("/").pop() + ":" + (line ?? "?") : ""}`);
    };
    wc.on("console-message", this.ytmConsoleHandler);
    this.ytmErrorHandler = (e: any) => {
      console.error("[YTMCuncaught]", JSON.stringify(e).slice(0, 400));
    };
    wc.on("render-process-gone", this.ytmErrorHandler);

    this.teardown = () => {
      if (!wc.isDestroyed()) {
        wc.removeListener("dom-ready", onDomReady);
        if (this.ytmConsoleHandler) wc.removeListener("console-message", this.ytmConsoleHandler);
        if (this.ytmErrorHandler) wc.removeListener("render-process-gone", this.ytmErrorHandler);
      }
      this.teardown = null;
    };
  }

  private injectedContent = "";
  private wcLastContent = new WeakMap<Electron.WebContents, string>();

  /* ------------------------------------------------------------
     RIFF CSS: channEl ADOPTED SHEETS.
     El canal insertCSS del CustomCSS colapsa el render incremental
     de Polymer (browse h=0 con contenido en DOM — probado con una
     regla trivial 2026-11-06). adoptedStyleSheets NO dispara ese
     pipeline y aplica exacto. El CSS vive en riff-theme.css y se
     re-adopta en cada hot-edit (watcher). customCSSPath queda en
     null para que CustomCSS no inyecte por su canal.
     ------------------------------------------------------------ */
  private readonly riffCssPath =
    "C:\\Users\\elpep\\Documents\\Agentes de open code\\admin de la pc\\proyectos\\riff-ytmda\\riff-theme.css";
  private cssLastContent = "";
  private cssWatcher: fs.FSWatcher | null = null;
  private cssDebounce: NodeJS.Timeout | null = null;
  private currentWc: Electron.WebContents | null = null;

  private async injectRiffCss(wc: Electron.WebContents, force = false) {
    if (!wc || wc.isDestroyed()) {
      wc = this.currentWc as Electron.WebContents;
      if (!wc || wc.isDestroyed()) return;
    }
    if (!fs.existsSync(this.riffCssPath)) return;
    let content = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        content = fs.readFileSync(this.riffCssPath, "utf8");
        break;
      } catch (e: any) {
        if (attempt === 4) {
          console.error("[CustomJS][riff-css] read failed after retries:", e?.message || e);
          return;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    if (!force && content === this.cssLastContent) return;
    this.cssLastContent = content;
    try {
      await wc.executeJavaScript(
        "(function(){\n" +
        "  try {\n" +
        "    const sheet = new CSSStyleSheet();\n" +
        "    sheet.replaceSync(" + JSON.stringify(content) + ");\n" +
        "    const keep = (document.adoptedStyleSheets || []).filter(function (s) { return !s.__riffFlag; });\n" +
        "    Object.defineProperty(sheet, '__riffFlag', { value: true });\n" +
        "    document.adoptedStyleSheets = keep.concat([sheet]);\n" +
        "    window.__riffCssEpoch = (window.__riffCssEpoch || 0) + 1;\n" +
        "  } catch (e) { console.error('[riff-css]', e); }\n" +
        "})();",
        true,
      );
    } catch (e) {
      console.error("[CustomJS][riff-css] adopt failed:", e);
    }
    this.watchCssFile(this.riffCssPath);
  }

  private watchCssFile(p: string) {
    if (this.cssWatcher) {
      this.cssWatcher.close();
      this.cssWatcher = null;
    }
    if (!p) return;
    this.cssWatcher = fs.watch(p, {}, () => {
      if (this.cssDebounce) return;
      this.cssDebounce = setTimeout(() => {
        this.cssDebounce = null;
        // Force: siempre re-adopta (el contenido puede haber cambiado).
        this.injectRiffCss(this.currentWc as Electron.WebContents, true).catch(() => {});
      }, 250);
    });
  }

  private async injectNow(wc: Electron.WebContents) {
    const jsPath = path.join(app.getPath("userData"), "custom", "js", "riff-navigation.js");
    if (!fs.existsSync(jsPath)) return;

    // Lectura con retry (fix EBUSY: el watcher puede disparar durante
    // el copiado/escritura del archivo).
    let content = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        content = fs.readFileSync(jsPath, "utf8");
        break;
      } catch (e: any) {
        if (attempt === 3) {
          console.error("[CustomJS] injectNow: read failed after retries:", e?.message || e);
          return;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    // Guard anti-churn: solo re-inyecta si la pagina no tiene el script
    // 0 si el contenido del archivo cambio (hot-reload). Sin esto, cada
    // dom-ready de la SPA de YT re-ejecuta el modulo Y renueva el epoch.
    const last = this.wcLastContent.get(wc);
    const already: unknown = await wc
      .executeJavaScript('!!window.__riffNavInjected', true)
      .catch(() => false);
    if (already && last === content) return;

    try {
      await wc.executeJavaScript(
        `(function () {\n` +
        `  if (window.__riffNavInjected) return;\n` +
        `  window.__riffNavInjected = true;\n` +
        `  try {\n${content}\n} catch (e) { console.error("[riff-navigation]", e); }\n` +
        `})();`,
        true,
      );
      this.wcLastContent.set(wc, content);
      this.watchJSFile(jsPath);
    } catch (e) {
      console.error("[CustomJS] Injection failed:", e);
    }

    // ---- PROBE: dump page state into the main-process log ----
    setTimeout(() => {
      if (wc.isDestroyed()) return;
      const probe = `(() => {
        const q = (s) => { try { const e = document.querySelector(s); return e ? (e.src || e.currentSrc || 'SEL-OK-NO-SRC') : null; } catch (_) { return 'ERR'; } };
        const rawVar = getComputedStyle(document.documentElement).getPropertyValue('--riff-album-art') || '(empty)';
        const accentLog = window.__riffAccentLog || '(none)';
        const accentObj = window.__riffAccent ? JSON.stringify(window.__riffAccent) : '(none)';
        const glowVar = getComputedStyle(document.documentElement).getPropertyValue('--riff-accent-glow') || '(empty)';
        const accentVar = getComputedStyle(document.documentElement).getPropertyValue('--riff-accent') || '(empty)';
        const cv = document.getElementById('riff-audio-visualizer');
        const canvasInfo = cv ? JSON.stringify({
          parent: cv.parentElement ? cv.parentElement.tagName : 'DETACHED',
          parentIsBar: !!(cv.parentElement && cv.parentElement.matches('ytmusic-player-bar')),
          zIndex: cv.style.zIndex,
          css: cv.style.cssText.slice(0, 100),
          epoch: window.__riffVisEpoch || 0
        }) : 'NO-CANVAS';
        return Promise.resolve(JSON.stringify({
          url: location.href,
          guard: !!window.__riffNavInjected,
          artVarRaw: rawVar,
          acctLog: accentLog,
          accentObj: accentObj,
          cssAccent: accentVar.trim(),
          cssGlow: glowVar.trim(),
          canvasInfo: canvasInfo
        }));
      })()`;
      wc.executeJavaScript(probe, true)
        .then((r) => console.log("[CustomJS] probe:", r))
        .catch((e) => console.error("[CustomJS] probe failed:", e));
    }, 3500);

    // ---- SEARCH DUMP: who paints the black strip under the pill? ----
    setTimeout(() => {
      if (wc.isDestroyed()) return;
      const dump = `(() => {
        return new Promise((resolve) => {
          const sb = document.querySelector('ytmusic-search-box') || document.querySelector('#masthead-search');
          if (!sb) { resolve(JSON.stringify({error: 'no search box found', nav: !!document.querySelector('ytmusic-nav-bar')})); return; }
          try { const inp = sb.matches('input') ? sb : null; } catch (_) {}
          setTimeout(() => {
            const out = [];
            const grab = (el, depth) => {
              out.push({
                d: depth,
                tag: el.tagName,
                id: el.id || '',
                cls: String(el.className || '').slice(0, 90),
                bg: getComputedStyle(el).backgroundColor,
                y: Math.round(el.getBoundingClientRect().top),
                h: Math.round(el.getBoundingClientRect().height),
                w: Math.round(el.getBoundingClientRect().width),
                x: Math.round(el.getBoundingClientRect().left)
              });
              if (depth < 4) Array.from(el.children).forEach(c => grab(c, depth + 1));
            };
            grab(sb, 0);
            resolve(JSON.stringify(out));
          }, 600);
        });
      })()`;
      wc.executeJavaScript(dump, true)
        .then((r) => console.log("[CustomJS] searchDump:", r))
        .catch((e) => console.error("[CustomJS] searchDump failed:", e));
    }, 6500);

    // ---- PROGRESS DUMP: Real DOM inside YTM's progress bar ----
    setTimeout(() => {
      if (wc.isDestroyed()) return;
      const dump2 = `(() => {
        return new Promise((resolve) => {
          const pb = document.querySelector('#progress-bar') || document.querySelector('ytmusic-player-bar');
          if (!pb) { resolve(JSON.stringify({error: 'no progress bar'})); return; }
          const out = [];
          const grab = (el, depth) => {
            const cs = getComputedStyle(el);
            out.push({
              d: depth,
              tag: el.tagName,
              id: el.id || '',
              cls: String(el.className || '').slice(0, 90),
              bg: cs.backgroundColor,
              h: Math.round(el.getBoundingClientRect().height),
              w: Math.round(el.getBoundingClientRect().width)
            });
            if (depth < 4) Array.from(el.children).forEach((c) => grab(c, depth + 1));
          };
          grab(pb, 0);
          resolve(JSON.stringify(out));
        });
      })()`;
      wc.executeJavaScript(dump2, true)
        .then((r) => console.log("[CustomJS] progressDump:", r))
        .catch((e) => console.error("[CustomJS] progressDump failed:", e));
    }, 8000);

    // ---- GUIDE DUMP: discover the real active-entry selector for the sidebar pill ----
  setTimeout(() => {
    if (wc.isDestroyed()) return;
    const guideDump = `(() => {
      return new Promise((resolve) => {
        const g = document.querySelector('ytmusic-guide-section-renderer ytmusic-guide-entry-renderer');
        if (!g) { resolve(JSON.stringify({error: 'no guide entry'})); return; }
        const entries = [...document.querySelectorAll('ytmusic-guide-section-renderer ytmusic-guide-entry-renderer')].map((el, idx) => ({
          idx: idx,
          ariaCurrent: el.getAttribute('aria-current'),
          hasSelected: el.hasAttribute('selected'),
          cls: String(el.className || '').slice(0, 60),
          html: el.innerHTML.slice(0, 260).replace(/\\s+/g, ' ')
        }));
        resolve(JSON.stringify({count: entries.length, entries: entries}));
      });
    })()`;
    wc.executeJavaScript(guideDump, true)
      .then((r) => console.log("[CustomJS] guideDump:", r))
      .catch((e) => console.error("[CustomJS] guideDump failed:", e));
  }, 4500);

  // ---- BOX FORENSICS: WHICH element paints the translucent band? ----
    setTimeout(() => {
      if (wc.isDestroyed()) return;
      const dumpBox = `(() => {
        return new Promise((resolve) => {
          const pb = document.querySelector('#progress-bar');
          if (!pb) { resolve(JSON.stringify({error: 'no #progress-bar'})); return; }
          const r = pb.getBoundingClientRect();
          const y = r.top + 4;
          const x = r.left + r.width / 2;
          const stack = document.elementsFromPoint(x, y).map((el) => {
            const cs = getComputedStyle(el);
            return {
              tag: el.tagName,
              id: el.id || '',
              cls: String(el.className || '').slice(0, 70),
              bg: cs.backgroundColor,
              op: cs.opacity,
              z: cs.zIndex,
              pos: cs.position,
              shadow: cs.boxShadow.slice(0, 60),
              h: Math.round(el.getBoundingClientRect().height)
            };
          });
          const cv = document.getElementById('riff-audio-visualizer');
          resolve(JSON.stringify({
            barRect: { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) },
            probePoint: { x: Math.round(x), y: Math.round(y) },
            stack: stack,
            canvas: cv ? {
              parent: cv.parentElement ? cv.parentElement.tagName : 'DETACHED',
              css: cv.style.cssText.slice(0, 120),
              computedOpacity: getComputedStyle(cv).opacity
            } : 'NO-CANVAS'
          }));
        });
      })()`;
      wc.executeJavaScript(dumpBox, true)
        .then((r) => console.log("[CustomJS] boxProbe:", r))
        .catch((e) => console.error("[CustomJS] boxProbe failed:", e));
    }, 5500);

    // ---- NAV FORENSICS: containing-block causers among bar's ancestors ----
    setTimeout(() => {
      if (wc.isDestroyed()) return;
      const dumpNav = `(() => {
        return new Promise((resolve) => {
          const bar = document.querySelector('ytmusic-player-bar');
          if (!bar) { resolve(JSON.stringify({error: 'no bar'})); return; }
          const r = bar.getBoundingClientRect();
          const chain = [];
          let el = bar;
          while (el && el !== document.documentElement) {
            const cs = getComputedStyle(el);
            chain.push({
              tag: el.tagName,
              id: el.id || '',
              cls: String(el.className || '').slice(0, 60),
              pos: cs.position,
              transform: cs.transform !== 'none' ? cs.transform.slice(0, 40) : 'none',
              filter: cs.filter !== 'none' ? cs.filter.slice(0, 30) : 'none',
              willChange: cs.willChange,
              perspective: cs.perspective !== 'none' ? cs.perspective : 'none',
              contain: cs.contain !== 'none' ? cs.contain : 'none',
              backdropFilter: cs.backdropFilter && cs.backdropFilter !== 'none' ? cs.backdropFilter.slice(0, 20) : 'none'
            });
            el = el.parentElement;
          }
          resolve(JSON.stringify({
            barRect: { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) },
            barPos: getComputedStyle(bar).position,
            barBottom: getComputedStyle(bar).bottom,
            chain: chain
          }));
        });
      })()`;
      wc.executeJavaScript(dumpNav, true)
        .then((r) => console.log("[CustomJS] navProbe:", r))
        .catch((e) => console.error("[CustomJS] navProbe failed:", e));
    }, 7000);

    // ---- SCRIM PROBE: real computed bg of the top-region layers ----
    setTimeout(() => {
      if (wc.isDestroyed()) return;
      const scrimDump = `(() => {
        const targets = [
          ['#progress-bar', 'progress-bar'],
          ['#nav-bar-background', 'nav-bar-background'],
          ['#mini-guide-background', 'mini-guide-background'],
          ['ytmusic-app-layout', 'app-layout'],
          ['#player-page', 'player-page']
        ];
        const out = targets.map(([sel, label]) => {
          const el = document.querySelector(sel);
          if (!el) return { label: label, missing: true };
          const cs = getComputedStyle(el);
          return {
            label: label,
            tag: el.tagName,
            bg: cs.backgroundColor,
            inlineStyle: (el.getAttribute('style') || '').slice(0, 120),
            rect: {
              top: Math.round(el.getBoundingClientRect().top),
              h: Math.round(el.getBoundingClientRect().height)
            }
          };
        });
        return JSON.stringify(out);
      })()`;
      wc.executeJavaScript(scrimDump, true)
        .then((r) => console.log("[CustomJS] scrimProbe:", r))
        .catch((e) => console.error("[CustomJS] scrimProbe failed:", e));
    }, 9000);

    // ---- SHELF PROBE: por que los estantes no se ven? (periodico x12) ----
    let shelfRun = 0;
    const shelfTimer = setInterval(() => {
      shelfRun++;
      if (shelfRun > 12 || wc.isDestroyed()) { clearInterval(shelfTimer); return; }
      const shelfDump = `(() => {
        const out = { url: location.pathname.slice(0, 40), shelves: [], items: 0, landing: [], suspect: [], pages: [], hero: [] };
        const vis = (el) => {
          const cs = getComputedStyle(el);
          return { v: cs.visibility, o: cs.opacity, d: cs.display };
        };
        document.querySelectorAll('ytmusic-shelf').forEach((sh, i) => {
          if (i >= 8) return;
          const r = sh.getBoundingClientRect();
          out.shelves.push({ i: i, h: Math.round(r.height), top: Math.round(r.top), ...vis(sh) });
        });
        out.items = document.querySelectorAll('ytmusic-two-row-item-renderer, ytmusic-responsive-list-item-renderer, ytmusic-list-item-renderer').length;
        const lp = document.querySelector('ytmusic-custom-index-landing-page');
        if (lp) {
          out.landing.push({ ...vis(lp), h: Math.round(lp.getBoundingClientRect().height) });
          let anc = lp.parentElement;
          while (anc && anc !== document.documentElement) {
            const cs = getComputedStyle(anc);
            if (cs.visibility !== 'visible' || parseFloat(cs.opacity) === 0 || cs.display === 'none') {
              out.suspect.push({ tag: anc.tagName + (anc.id ? '#' + anc.id : ''), v: cs.visibility, o: cs.opacity, d: cs.display });
            }
            anc = anc.parentElement;
          }
        } else { out.landing.push('no-landing-el'); }
        document.querySelectorAll('ytmusic-browse-response, ytmusic-search-page, ytmusic-player-page').forEach((pg) => {
          const r = pg.getBoundingClientRect();
          const cs = getComputedStyle(pg);
          out.pages.push({ tag: pg.tagName, v: cs.visibility, o: cs.opacity, anim: cs.animationName + '/' + cs.animationPlayState, h: Math.round(r.height), inline: (pg.getAttribute('style') || '').slice(0, 80) });
        });
        // HERO: fullbleed renderers — rect/z + ::after computado
        document.querySelectorAll('ytmusic-fullbleed-thumbnail-renderer').forEach((el, i) => {
          if (i >= 4) return;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          const after = getComputedStyle(el, '::after');
          const img = el.querySelector('img');
          const imgCs = img ? getComputedStyle(img) : null;
          out.hero.push({
            i: i,
            r: { top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width) },
            pos: cs.position, z: cs.zIndex,
            after: { content: after.content, bg: after.backgroundColor, bgi: after.backgroundImage.slice(0, 80), v: after.visibility, z: after.zIndex },
            img: imgCs ? { v: imgCs.visibility, o: imgCs.opacity, filter: imgCs.filter.slice(0, 40), rect: { top: Math.round(img.getBoundingClientRect().top), h: Math.round(img.getBoundingClientRect().height) } } : 'no-img'
          });
        });
        return JSON.stringify(out);
      })()`;
      wc.executeJavaScript(shelfDump, true)
        .then((r) => console.log("[CustomJS] shelfProbe:", r))
        .catch((e) => console.error("[CustomJS] shelfProbe failed:", e));
    }, 12000);

    // ---- THUMB DUMP: todas las img con src REAL en la pagina de
    // video — para wirear el fallback de cover-en-video ----
    let thRun = 0;
    const thumbTimer = setInterval(() => {
      thRun++;
      if (thRun > 4 || wc.isDestroyed()) { clearInterval(thumbTimer); return; }
      const thumbDump = `(() => {
        const out = [];
        document.querySelectorAll('img').forEach((el) => {
          const src = el.currentSrc || el.src || '';
          if (!src || src.startsWith('data:')) return;
          const r = el.getBoundingClientRect();
          if (r.width < 40 || r.height < 40) return;
          const chain = [];
          let n = el.parentElement, d = 0;
          while (n && d < 3) { chain.push(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + '.' + Array.from(n.classList).slice(0, 2).join('.')); n = n.parentElement; d++; }
          out.push({ w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), src: src.split('/').pop().slice(0, 40), chain: chain.join('|') });
        });
        return JSON.stringify(out.slice(0, 12));
      })()`;
      wc.executeJavaScript(thumbDump, true)
        .then((r) => console.log("[CustomJS] thumbDump:", r))
        .catch((e) => console.error("[CustomJS] thumbDump failed:", e));
    }, 6000);

    // ---- EQ PROBE: persistencia y wiring cada 20s x5 ---
    let eqRun = 0;
    const eqTimer = setInterval(() => {
      eqRun++;
      if (eqRun > 5 || wc.isDestroyed()) { clearInterval(eqTimer); return; }
      const eqDump = `(() => {
        const ls = (() => { try { return localStorage.getItem('riff_eq_gains_v1') || '(sin guardar)'; } catch (e) { return 'LS-ERROR:' + e.message; } })();
        return JSON.stringify({
          eqWired: !!window.__riffEQWired,
          filters: (window.__riffEQFilters || []).length,
          gainsOnFilters: (window.__riffEQFilters || []).map((f) => Math.round(f.gain.value)).slice(0, 10),
          panel: !!document.getElementById('riff-eq-panel'),
          saved: ls.slice(0, 120)
        });
      })()`;
      wc.executeJavaScript(eqDump, true)
        .then((r) => console.log("[CustomJS] eqProbe:", r))
        .catch((e) => console.error("[CustomJS] eqProbe failed:", e));
    }, 20000);

    // ---- DECISIVE PROBE (H1/H2): computed ::before + hojas + vars ----
    setTimeout(() => {
      if (wc.isDestroyed()) return;
      const decisive = `(() => {
        const appEl = document.querySelector('ytmusic-app');
        const cs = appEl ? getComputedStyle(appEl, '::before') : null;
        return JSON.stringify({
          sheets: document.styleSheets.length,
          ambientVar: getComputedStyle(document.documentElement).getPropertyValue('--riff-ambient-solid').slice(0, 110),
          accentVar: getComputedStyle(document.documentElement).getPropertyValue('--riff-accent'),
          beforeBgImg: cs ? cs.backgroundImage.slice(0, 150) : 'no-app-el',
          beforeBgColor: cs ? cs.backgroundColor : '-',
          beforeZ: cs ? cs.zIndex : '-',
          appElInlineBg: appEl ? (appEl.style.background || '(none)').slice(0, 80) : '-'
        });
      })()`;
      wc.executeJavaScript(decisive, true)
        .then((r) => console.log("[CustomJS] decisiveProbe:", r))
        .catch((e) => console.error("[CustomJS] decisiveProbe failed:", e));
    }, 5500);

    // ---- SEAM PROBE: what paints the hard break between the halves? ----
    setTimeout(() => {
      if (wc.isDestroyed()) return;
      const seam = `(() => {
        const probes = [300, 430, 560];
        const out = {};
        for (const y of probes) {
          const stack = document.elementsFromPoint(window.innerWidth / 2, y).slice(0, 6).map((el) => {
            const cs = getComputedStyle(el);
            let bgi = 'none';
            try {
              bgi = cs.backgroundImage !== 'none' ? cs.backgroundImage.slice(0, 70) : 'none';
            } catch (_) {}
            return {
              tag: el.tagName,
              id: el.id || '',
              cls: String(el.className || '').slice(0, 55),
              bg: cs.backgroundColor,
              bgi: bgi,
              w: Math.round(el.getBoundingClientRect().width),
              h: Math.round(el.getBoundingClientRect().height),
              filter: cs.filter !== 'none' ? cs.filter.slice(0, 28) : 'none'
            };
          });
          out['y' + y] = stack;
        }
        return JSON.stringify(out);
      })()`;
      wc.executeJavaScript(seam, true)
        .then((r) => console.log("[CustomJS] seamProbe:", r))
        .catch((e) => console.error("[CustomJS] seamProbe failed:", e));
    }, 6000);
  }

  private watchJSFile(newFile?: string) {
    if (this.currentWatcher) {
      this.currentWatcher.close();
      this.currentWatcher = null;
    }
    if (!newFile) return;
    this.currentWatcher = fs.watch(newFile, {}, (type) => {
      if (type === "change") {
        const ytmViewManager = this.getService(YTMViewManager);
        ytmViewManager
          .ready()
          .then(() => {
            const view = ytmViewManager.getView();
            if (view?.webContents && !view.webContents.isDestroyed()) {
              // Clear the guard so the fresh script runs again on this page.
              view.webContents.executeJavaScript("window.__riffNavInjected = false;", true).catch(() => {});
              this.injectNow(view.webContents);
            }
          })
          .catch(() => {});
      }
    });
  }
}
