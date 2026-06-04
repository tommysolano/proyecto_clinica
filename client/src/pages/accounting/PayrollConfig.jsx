import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineCog6Tooth } from 'react-icons/hi2';

const ACCOUNT_LABELS = {
  sueldos: 'Gasto sueldos',
  beneficios: 'Gasto beneficios sociales',
  iessPatronal: 'Gasto aporte patronal',
  iessPorPagar: 'IESS por pagar',
  sueldosPorPagar: 'Sueldos por pagar',
  irPorPagar: 'Impuesto a la renta por pagar',
  prestamosPorCobrar: 'Préstamos empleados por cobrar',
  provisionesPorPagar: 'Provisiones por pagar',
};

export default function PayrollConfig() {
  const [cfg, setCfg] = useState(null);

  useEffect(() => { api.get('/payroll/config').then((r) => setCfg(r.data)).catch((e) => toast.error(e.response?.data?.message || 'Error')); }, []);

  const save = async () => {
    try { const r = await api.put('/payroll/config', cfg); setCfg(r.data); toast.success('Configuración guardada'); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  if (!cfg) return <div className="p-8 text-slate-400">Cargando...</div>;
  const num = (k) => (e) => setCfg({ ...cfg, [k]: +e.target.value });
  const inputCls = 'border border-slate-200 rounded-lg px-3 py-2 w-full';

  return (
    <div className="space-y-4 max-w-3xl">
      <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineCog6Tooth className="text-emerald-600" /> Configuración de Nómina</h1>

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4 space-y-3">
        <h2 className="font-semibold text-slate-700">Parámetros</h2>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">Frecuencia de pago</span>
            <select value={cfg.paymentFrequency} onChange={(e) => setCfg({ ...cfg, paymentFrequency: e.target.value })} className={inputCls}><option value="MENSUAL">Mensual</option><option value="QUINCENAL">Quincenal</option></select>
          </label>
          <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">SBU (Salario Básico Unificado)</span><input type="number" step="0.01" value={cfg.sbu} onChange={num('sbu')} className={inputCls} /></label>
          <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">% IESS personal</span><input type="number" step="0.01" value={cfg.iessPersonal} onChange={num('iessPersonal')} className={inputCls} /></label>
          <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">% IESS patronal</span><input type="number" step="0.01" value={cfg.iessPatronal} onChange={num('iessPatronal')} className={inputCls} /></label>
          <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">% IECE</span><input type="number" step="0.01" value={cfg.iece} onChange={num('iece')} className={inputCls} /></label>
          <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">% SECAP</span><input type="number" step="0.01" value={cfg.secap} onChange={num('secap')} className={inputCls} /></label>
          <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">% Fondos de reserva</span><input type="number" step="0.01" value={cfg.fondosReserva} onChange={num('fondosReserva')} className={inputCls} /></label>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4 space-y-3">
        <h2 className="font-semibold text-slate-700">Cuentas contables (códigos del plan)</h2>
        <div className="grid grid-cols-2 gap-3">
          {Object.keys(ACCOUNT_LABELS).map((k) => (
            <label key={k} className="text-xs flex flex-col gap-1"><span className="text-slate-600">{ACCOUNT_LABELS[k]}</span>
              <input value={cfg.accounts?.[k] || ''} onChange={(e) => setCfg({ ...cfg, accounts: { ...cfg.accounts, [k]: e.target.value } })} className={inputCls} />
            </label>
          ))}
        </div>
      </div>

      <button onClick={save} className="px-5 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Guardar configuración</button>
    </div>
  );
}
