import { mount } from 'svelte';

import App from './App.svelte';
import PreviewApp from './PreviewApp.svelte';
import './styles/app.css';

const target = document.getElementById('app');
if (!target) throw new Error('Falta el nodo #app en index.html');

// El preview web no tiene runtime Tauri. Montar la aplicación real en un
// navegador provocaría errores de IPC y una página en blanco; el modo de
// preview usa una fachada interactiva que permite revisar layout, pestañas,
// entrada y salidas sin tocar el sistema.
export default mount(import.meta.env.VITE_LTERMINAL_PREVIEW === '1' ? PreviewApp : App, { target });
