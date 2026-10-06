import { useEffect, useState } from 'react';
import api from '../api/axios';
import { isCompanyScope, setCompanyScope } from '../utils/accountingScope';

/**
 * Selector de la cabecera en las pantallas contables: el centro de costo de la sucursal
 * activa o «Toda la empresa». Solo aparece si la sucursal está ligada a un centro.
 */
export default function AccountingScopeSwitch({ clinicId }) {
  // La respuesta guarda de qué sucursal es: al cambiar de sucursal no se muestra la anterior.
  const [loaded, setLoaded] = useState({ clinicId: null, scope: null });

  useEffect(() => {
    let alive = true;
    api.get('/cost-centers/scope')
      .then((r) => { if (alive) setLoaded({ clinicId, scope: r.data }); })
      .catch(() => { if (alive) setLoaded({ clinicId, scope: null }); });
    return () => { alive = false; };
  }, [clinicId]);

  const scope = loaded.clinicId === clinicId ? loaded.scope : null;
  if (!scope?.linked) return null;
  const company = isCompanyScope();
  return (
    <label
      className="flex items-center gap-2 text-xs text-slate-500 min-w-0"
      title="Datos de Contífico del centro de costo de esta sucursal, o de toda la empresa"
    >
      <span className="hidden lg:inline">Contabilidad</span>
      <select
        value={company ? 'company' : 'cc'}
        onChange={(e) => setCompanyScope(e.target.value === 'company')}
        className={`max-w-[9.5rem] sm:max-w-none px-2.5 sm:px-3 py-2 rounded-xl border text-xs font-medium cursor-pointer ${
          company ? 'bg-slate-50 border-slate-200 text-slate-700' : 'bg-emerald-50 border-emerald-100 text-emerald-700'
        }`}
      >
        <option value="cc">{scope.sucursalCostCenter?.name || 'Centro de la sucursal'}</option>
        <option value="company">Toda la empresa</option>
      </select>
    </label>
  );
}
