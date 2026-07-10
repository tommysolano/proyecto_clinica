import { HiOutlineExclamationTriangle } from 'react-icons/hi2';
import { isConsumidorFinal } from '../utils/consumidorFinal';

/**
 * Alerta visible que se muestra en TODO módulo que emita factura (Nueva Venta,
 * cobro en recepción, cajas) cuando el cliente es consumidor final: por
 * disposiciones vigentes del SRI estos comprobantes podrían no permitir
 * anulación ni nota de crédito, así que hay que verificar los datos antes de
 * cobrar. Renderiza null si no aplica.
 */
export default function ConsumidorFinalAlert({ cedula, className = '' }) {
  if (!isConsumidorFinal(cedula)) return null;
  return (
    <div className={`bg-amber-50 border border-amber-300 rounded-xl p-3 flex items-start gap-2 text-amber-800 ${className}`}>
      <HiOutlineExclamationTriangle className="w-5 h-5 shrink-0 mt-0.5" />
      <div className="text-sm">
        <p className="font-semibold">Está emitiendo una factura a consumidor final.</p>
        <p className="mt-0.5">Verifique que los datos sean correctos antes de cobrar. Este comprobante podría no permitir anulación ni nota de crédito según disposiciones vigentes del SRI.</p>
      </div>
    </div>
  );
}
