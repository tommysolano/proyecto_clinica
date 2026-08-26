import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Aplicar tema de color guardado (verde por defecto).
const savedTheme = localStorage.getItem('theme');
if (savedTheme && savedTheme !== 'green') {
  document.documentElement.dataset.theme = savedTheme;
}

// PWA: el service worker es lo que hace que Android ofrezca instalar Vikingo
// (y lo que permite abrirlo sin cobertura). Solo en producción — en desarrollo
// se quedaría en medio del recargado en caliente de Vite.
// Qué cachea y qué NO (la API nunca) está explicado en public/sw.js.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Sin service worker la app funciona igual; solo no se puede instalar.
    });
  });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
