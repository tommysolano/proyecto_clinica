import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineAdjustmentsHorizontal } from 'react-icons/hi2';
import AccountSelect from '../../components/AccountSelect';

/**
 * Configuración del mapa de cuentas contables: el contador define qué cuenta
 * usa el sistema para cada concepto (ventas, IVA, retenciones, comisiones, etc.)
 * en lugar de que se elijan automáticamente por código fijo.
 */
export default function AccountMapping() {
  const [roles, setRoles] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const [r, a] = await Promise.all([
      api.get('/accounting-config'),
      api.get('/chart-of-accounts'),
    ]);
    setRoles(r.data.roles || []);
    // Lista completa (incluye agrupadoras): AccountSelect las usa para la ruta padre.
    setAccounts(a.data || []);
    const d = {};
    (r.data.roles || []).forEach((role) => { d[role.key] = role.configured || ''; });
    setDraft(d);
  };
  useEffect(() => { load().catch((e) => toast.error(e.response?.data?.message || 'Error')); }, []);

  const groups = [...new Set(roles.map((r) => r.group))];

  const save = async () => {
    setSaving(true);
    try {
      await api.put('/accounting-config', { accounts: draft });
      toast.success('Configuración guardada');
      load();
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineAdjustmentsHorizontal className="text-emerald-600" /> Configuración de Cuentas</h1>
          <p className="text-sm text-slate-500">Define qué cuenta contable usa el sistema para cada concepto. Si dejas "(Predeterminada)", se usa la cuenta estándar del plan.</p>
        </div>
        <button onClick={save} disabled={saving} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 disabled:opacity-50">{saving ? 'Guardando...' : 'Guardar'}</button>
      </div>

      {groups.map((g) => (
        <div key={g} className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
          <div className="px-4 py-2 bg-emerald-50 text-sm font-semibold text-emerald-700">{g}</div>
          <table className="tbl">
            <thead className="text-xs text-slate-500"><tr><th className="px-4 py-2 text-left">Concepto</th><th className="px-4 py-2 text-left">Cuenta a usar</th><th className="px-4 py-2 text-left">Efectiva actual</th></tr></thead>
            <tbody>
              {roles.filter((r) => r.group === g).map((r) => (
                <tr key={r.key} className="border-t">
                  <td className="px-4 py-2 font-medium text-slate-700">{r.label}</td>
                  <td className="px-4 py-2">
                    <div className="max-w-md">
                      <AccountSelect accounts={accounts} value={draft[r.key] || ''} onChange={(v) => setDraft({ ...draft, [r.key]: v })} emptyOption={`(Predeterminada: ${r.defaultCode})`} size="sm" />
                    </div>
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-500">{r.effective ? `${r.effective.code} ${r.effective.name}` : <span className="text-rose-500">No resuelta</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
