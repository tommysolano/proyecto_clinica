import { FaFacebook, FaInstagram, FaTiktok, FaYoutube } from 'react-icons/fa6';

const ICONS = { facebook: FaFacebook, instagram: FaInstagram, tiktok: FaTiktok, youtube: FaYoutube };
// Colores de marca de cada red: es lo que el equipo reconoce de un vistazo en el calendario.
const COLORS = { facebook: '#1877F2', instagram: '#E1306C', tiktok: '#111827', youtube: '#FF0000' };

export default function NetworkIcon({ network, className = 'w-4 h-4', colored = true }) {
  const Icon = ICONS[network];
  if (!Icon) return null;
  return <Icon className={className} style={colored ? { color: COLORS[network] } : undefined} aria-label={network} />;
}
