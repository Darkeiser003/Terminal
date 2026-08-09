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
    // Linux. No hace falta transpilar para navegadores antiguos.
    build: {
        target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
        minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
        sourcemap: !!process.env.TAURI_ENV_DEBUG
    }
});
