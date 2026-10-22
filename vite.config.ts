import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// El puerto es fijo y `strictPort` está activo a propósito: tauri.conf.json
// apunta a esta URL en desarrollo, y que Vite se mueva solo a otro puerto
// dejaría la ventana en blanco sin decir por qué.
const HOST = process.env.TAURI_DEV_HOST;

export default defineConfig({
    plugins: [svelte()],
    clearScreen: false,
    server: {
        port: 1420,
        strictPort: true,
        host: HOST || false,
        hmr: HOST ? { protocol: 'ws', host: HOST, port: 1421 } : undefined,
        watch: {
            // src-tauri lo vigila el propio `tauri dev`; que Vite también lo
            // haga provoca recargas dobles en cada `cargo build`.
            ignored: ['**/src-tauri/**', '**/electron/**']
        }
    },
    // Tauri fija el motor: WebView2 (Chromium) en Windows y WebKitGTK en
    // Linux; esta opción no lo cambia, solo decide hasta qué versión de
    // JavaScript se reescribe el código. Un único estándar para las dos
    // plataformas: ES2023 se entrega tal cual a WebView2 (Chromium 105 o
    // posterior) y a WebKitGTK 2.40 o posterior (los bloques `static` de clase
    // de ES2022 son lo más nuevo que necesita). Antes Linux apuntaba a
    // `safari13` y se reescribían campos privados, `??=` y demás sintaxis que
    // usan Svelte 5 y xterm 6, con un bundle más grande y más lento.
    build: {
        outDir: process.env.VITE_OUT_DIR || 'dist',
        target: 'es2023',
        minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
        sourcemap: !!process.env.TAURI_ENV_DEBUG,
        // xterm y sus addons son la parte más pesada y solo los necesita la
        // vista de terminal. Separarlos permite que el código de paneles y
        // configuración tenga su propio caché y evita un único chunk enorme.
        rollupOptions: {
            output: {
                manualChunks: {
                    terminal: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-search', '@xterm/addon-image', '@xterm/addon-unicode11']
                }
            }
        }
    }
});
