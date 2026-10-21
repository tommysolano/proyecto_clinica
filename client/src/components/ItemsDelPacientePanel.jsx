import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import api from '../api/axios';
import Modal from './Modal';
import NumericInput from './NumericInput';
import { useAuth } from '../context/AuthContext';
import { fmtDate } from '../utils/date';

/**
 * LO QUE EL PACIENTE TIENE A SU NOMBRE (oct-2026, ver server models/PatientItem).
 *
 *  · Guardado en la clínica — lo compró y NO se lo llevó. Ya está pagado: no se le
 *    cobra otra vez. Sale del inventario cuando se le aplica (en el cobro del
 *    servicio que lo usa, o aquí con «Aplicar» si vino solo a ponérselo).
 *  · Se lo llevó — ítems vinculados de un servicio que compró y se llevó: si los
 *    trae, al cobrar se marcan «Lo trajo el paciente» y no se descuentan.
 *
 * Arriba de la ficha, para que lo vea quien cobra y quien lo aplica. Sin nada a su
 * nombre no se pinta.
 */
export default function ItemsDelPacientePanel({ patientId }) {
  const { hasRole } = useAuth();
  const puedeVer = hasRole('admin', 'cajero', 'contabilidad', 'enfermero');
  const puedeAplicar = hasRole('admin', 'cajero', 'enfermero');
  const [items, setItems] = useState([]);
  const [aplicando, setAplicando] = useState(null); // { item, quantity, note }
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    if (!puedeVer || !patientId) return undefined;
    let vivo = true;
    api.get(`/patients/${patientId}/items`)
      .then((r) => { if (vivo) setItems(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (vivo) setItems([]); });
    return () => { vivo = false; };
  }, [patientId, puedeVer]);

  if (!puedeVer || !items.length) return null;
  const enClinica = items.filter((i) => i.mode === 'en_clinica');
  const llevados = items.filter((i) => i.mode === 'llevado');

  const aplicar = async () => {
    const qty = Number(aplicando.quantity);
    if (!(qty > 0) || qty > aplicando.item.remaining) {
      toast.error(`Indica una cantidad entre 1 y ${aplicando.item.remaining}`);
      return;
    }
    setGuardando(true);
    try {
      const { data } = await api.post(`/patients/${patientId}/items/${aplicando.item._id}/aplicar`, {
        quantity: qty, note: aplicando.note,
      });
      setItems(Array.isArray(data?.items) ? data.items : []);
      toast.success(aplicando.item.mode === 'en_clinica' ? 'Aplicado: salió del inventario' : 'Anotado como aplicado');
      for (const w of data?.warnings || []) toast(w, { icon: '⚠️', duration: 7000 });
      setAplicando(null);
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo registrar');
    } finally {
      setGuardando(false);
    }
  };

  const fila = (i) => (
    <li key={i._id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 border-t border-amber-100 first:border-t-0">
      <span className="flex-1 min-w-[10rem] text-sm text-slate-800 break-words">
        <strong>{i.productName}</strong>
        <span className="text-slate-600"> · le quedan <strong>{i.remaining}</strong>{i.quantity !== i.remaining ? ` de ${i.quantity}` : ''}</span>
        <span className="block text-[11px] text-slate-500">
          {i.mode === 'en_clinica' ? 'Comprado' : 'Comprado y llevado'} el {fmtDate(i.date)}{i.saleNumber ? ` · ${i.saleNumber}` : ''}
        </span>
      </span>
      {puedeAplicar && (
        <button
          type="button"
          onClick={() => setAplicando({ item: i, quantity: String(i.remaining), note: '' })}
          className="px-2.5 py-1 text-xs rounded-lg border-none cursor-pointer bg-amber-600 hover:bg-amber-700 text-white"
        >
          Aplicar
        </button>
      )}
    </li>
  );

  return (
    <section className="rounded-2xl border border-amber-300 bg-amber-50/70 px-4 py-3">
      {enClinica.length > 0 && (
        <>
          <h3 className="text-sm font-semibold text-amber-900 m-0">Guardado en la clínica a su nombre · ya pagado</h3>
          <p className="text-[11px] text-amber-800 mt-0.5 mb-1">
            Lo compró y no se lo llevó. No se le cobra otra vez: al cobrar el servicio que lo usa, escoge «Guardado del paciente».
          </p>
          <ul className="list-none m-0 p-0">{enClinica.map(fila)}</ul>
        </>
      )}
      {llevados.length > 0 && (
        <div className={enClinica.length ? 'mt-3' : ''}>
          <h3 className="text-sm font-semibold text-amber-900 m-0">Se lo llevó (puede traerlo para aplicárselo)</h3>
          <p className="text-[11px] text-amber-800 mt-0.5 mb-1">
            Si lo trae, al cobrar el servicio escoge «Lo trajo el paciente»: no se descuenta del inventario.
          </p>
          <ul className="list-none m-0 p-0">{llevados.map(fila)}</ul>
        </div>
      )}

      <Modal
        isOpen={!!aplicando}
        onClose={() => !guardando && setAplicando(null)}
        title={aplicando ? `Aplicar ${aplicando.item.productName}` : ''}
        size="sm"
      >
        {aplicando && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600 m-0">
              {aplicando.item.mode === 'en_clinica'
                ? 'Sale del inventario ahora. Úsalo cuando vino solo a aplicárselo; si se cobra un servicio, escógelo allí como «Guardado del paciente».'
                : 'Lo trajo el paciente: solo se anota como aplicado, no se descuenta del inventario.'}
            </p>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Cantidad (le quedan {aplicando.item.remaining})</label>
              <NumericInput
                value={aplicando.quantity}
                onChange={(e) => setAplicando((a) => ({ ...a, quantity: e.target.value }))}
                className="input w-32"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Nota (opcional)</label>
              <input
                value={aplicando.note}
                onChange={(e) => setAplicando((a) => ({ ...a, note: e.target.value }))}
                placeholder="Ej. aplicada en suero"
                className="input"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setAplicando(null)} disabled={guardando}
                className="px-4 py-2 text-sm rounded-lg border border-slate-200 bg-white cursor-pointer">
                Cancelar
              </button>
              <button type="button" onClick={aplicar} disabled={guardando}
                className="px-4 py-2 text-sm rounded-lg border-none bg-amber-600 hover:bg-amber-700 text-white cursor-pointer disabled:opacity-50">
                {guardando ? 'Guardando…' : 'Aplicar'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </section>
  );
}
