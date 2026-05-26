import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Aplicar tema de color guardado (verde por defecto).
const savedTheme = localStorage.getItem('theme');
if (savedTheme && savedTheme !== 'green') {
  document.documentElement.dataset.theme = savedTheme;
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
