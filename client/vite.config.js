import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import legacy from '@vitejs/plugin-legacy'

/**
 * COMPATIBILIDAD CON MÓVILES VIEJOS (sep-2026).
 *
 * El build moderno de Vite sale con sintaxis de hoy en día (`?.`, `??`, campos
 * de clase…), y el iPhone de un enfermero —o un Android viejo— ni siquiera
 * llega a PARSEARLO: la página carga y TODA la aplicación queda muerta (le das
 * a «Atender» y no pasa nada). plugin-legacy genera además un paquete
 * transpilado + polyfills (SystemJS) que se sirve solo a esos navegadores vía
 * `<script nomodule>`; los móviles modernos siguen cargando el bundle normal.
 */
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    legacy({
      // Explícito y antiguo a propósito: «defaults» ya no incluye los iOS de
      // los equipos que se quedaron sin actualizaciones (iPhone 6/7 y Android
      // WebView viejos son justo los que reportan los problemas).
      targets: [
        'chrome >= 61',
        'firefox >= 60',
        'safari >= 11',
        'ios_saf >= 11',
        'edge >= 79',
        'android >= 61',
        'not dead',
      ],
    }),
  ],
  server: {
    proxy: {
      '/api': 'http://localhost:5000',
      '/socket.io': {
        target: 'http://localhost:5000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
