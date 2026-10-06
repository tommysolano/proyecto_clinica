import { useState } from 'react';
import { companiesOf, companyKey } from '../utils/companies';

/**
 * EMPRESA → SUCURSAL al agendar (oct-2026).
 *
 * Primero se elige la empresa y después su sucursal; si la empresa tiene una sola
 * sucursal, queda marcada sola. Con una sola empresa en la lista no se pregunta: se
 * ve solo la sucursal, como siempre.
 *
 * Props:
 *   clinics   : sucursales que se pueden elegir (las de `/clinics?scope=names`, cada
 *               una con `company: { _id, name }`). Las inactivas no se ofrecen.
 *   value     : id de la sucursal elegida ('' = ninguna).
 *   onChange  : (clinicId) => void
 *   required  : marca los dos campos como obligatorios.
 *   label     : rótulo de la sucursal.
 *   selectClassName / labelClassName : clases, para que encaje con cada formulario.
 */
const DEFAULT_SELECT = 'w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50';

export default function CompanyClinicSelect({
  clinics, value, onChange, required = false, label = 'Sucursal destino', selectClassName = DEFAULT_SELECT,
  labelClassName = 'block text-sm font-medium text-slate-700 mb-1.5',
}) {
  const empresas = companiesOf(clinics);
  const elegida = (clinics || []).find((c) => String(c._id) === String(value || ''));
  // La empresa sale de la sucursal elegida; sin sucursal, la que se acaba de escoger.
  const [empresaSuelta, setEmpresaSuelta] = useState('');
  const empresa = elegida ? companyKey(elegida) : empresaSuelta;
  const sucursales = empresas.length > 1
    ? (empresas.find((e) => e._id === empresa)?.clinics || [])
    : (empresas[0]?.clinics || []);

  const elegirEmpresa = (id) => {
    setEmpresaSuelta(id);
    const suyas = empresas.find((e) => e._id === id)?.clinics || [];
    // Una sola sucursal: queda marcada por defecto.
    onChange(suyas.length === 1 ? String(suyas[0]._id) : '');
  };

  const etiqueta = labelClassName;
  return (
    <div className={empresas.length > 1 ? 'grid grid-cols-1 sm:grid-cols-2 gap-3' : ''}>
      {empresas.length > 1 && (
        <div>
          <label className={etiqueta}>Empresa{required ? ' *' : ''}</label>
          <select value={empresa} onChange={(e) => elegirEmpresa(e.target.value)} required={required} className={selectClassName}>
            <option value="">Seleccionar empresa</option>
            {empresas.map((e) => <option key={e._id} value={e._id}>{e.name}</option>)}
          </select>
        </div>
      )}
      {(empresas.length <= 1 || sucursales.length > 1 || (empresa && !sucursales.length)) && (
        <div>
          <label className={etiqueta}>{label}{required ? ' *' : ''}</label>
          <select
            name="clinic"
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            required={required}
            disabled={empresas.length > 1 && !empresa}
            className={selectClassName}
          >
            <option value="">{empresas.length > 1 && !empresa ? 'Primero la empresa' : 'Seleccionar sucursal'}</option>
            {sucursales.map((c) => (
              <option key={c._id} value={c._id}>{c.nombreComercial || c.name}</option>
            ))}
          </select>
        </div>
      )}
      {empresas.length > 1 && sucursales.length === 1 && empresa && (
        <div>
          <label className={etiqueta}>{label}</label>
          <p className="px-4 py-2.5 rounded-xl text-sm bg-slate-50 border border-slate-100 text-slate-600">
            {sucursales[0].nombreComercial || sucursales[0].name}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Opciones de un filtro de sucursal agrupadas por empresa (<optgroup>) cuando hay más
 * de una; con una sola empresa, la lista de siempre.
 */
export function ClinicOptionsByCompany({ clinics }) {
  const empresas = companiesOf(clinics);
  const opcion = (c) => <option key={c._id} value={c._id}>{c.nombreComercial || c.name}</option>;
  if (empresas.length <= 1) return <>{(empresas[0]?.clinics || []).map(opcion)}</>;
  return (
    <>
      {empresas.map((e) => (
        <optgroup key={e._id} label={e.name}>{e.clinics.map(opcion)}</optgroup>
      ))}
    </>
  );
}
