import { useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { downloadFile } from '../../utils/download';
import { HiOutlineArrowDownTray, HiOutlineArrowUpTray, HiOutlineCloudArrowUp, HiOutlineCheckCircle, HiOutlineExclamationTriangle } from 'react-icons/hi2';

/**
 * Importación de datos por plantillas Excel (migración desde Contífico / carga
 * inicial real). Cada tarjeta descarga su plantilla y sube el archivo lleno.
 * El orden importa: primero plan de cuentas, luego categorías, luego el resto.
 */
const TYPES = [
  {
    key: 'plan-cuentas', order: 1, name: 'Plan de cuentas',
    desc: 'Código, nombre, tipo, naturaleza, jerarquía por puntos (1.1.01), permite movimiento. Impórtalo PRIMERO: todo lo demás referencia sus cuentas.',
    template: '/data-import/template/plan-cuentas', upload: '/data-import/plan-cuentas',
  },
  {
    key: 'categorias', order: 2, name: 'Categorías contables',
    desc: 'Categorías de inventario y activo fijo con sus cuentas (inventario, costo, venta, depreciación) y parámetros de depreciación.',
    template: '/data-import/template/categorias', upload: '/data-import/categorias',
  },
  {
    key: 'productos', order: 3, name: 'Productos y servicios',
    desc: 'Catálogo con tipo, categoría contable, precios, IVA y (opcional) cuentas específicas de inventario/costo/venta por producto.',
    template: '/inventory-advanced/template/products', upload: '/inventory-advanced/import/products-excel',
  },
  {
    key: 'activos', order: 4, name: 'Activos fijos',
    desc: 'Activos con su categoría (fuente de cuentas y vida útil), costo, fechas y depreciación acumulada para continuar desde Contífico.',
    template: '/data-import/template/activos', upload: '/data-import/activos',
  },
  {
    key: 'empleados', order: 5, name: 'Empleados / nómina',
    desc: 'Identificación, nombres, cargo, departamento, sueldo, contrato, fecha de ingreso, banco y beneficios (XIII, XIV, fondos de reserva).',
    template: '/data-import/template/empleados', upload: '/data-import/empleados',
  },
  {
    key: 'proveedores', order: 6, name: 'Proveedores',
    desc: 'RUC, razón social, régimen tributario, días de crédito y cuentas por defecto para compras.',
    template: '/data-import/template/proveedores', upload: '/data-import/proveedores',
  },
  {
    key: 'clientes', order: 7, name: 'Clientes',
    desc: 'Identificación, nombres, contacto y datos básicos para facturación (se crean como pacientes).',
    template: '/data-import/template/clientes', upload: '/data-import/clientes',
  },
];

function ImportCard({ type }) {
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState(null);
  const inputId = `file-${type.key}`;

  const downloadTemplate = async () => {
    try { await downloadFile(type.template); }
    catch (e) { toast.error(e.message); }
  };

  const upload = async () => {
    if (!file) return toast.error('Selecciona el archivo Excel lleno');
    setUploading(true);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.post(type.upload, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setResult(r.data);
      const errs = r.data?.errors?.length || 0;
      toast[errs ? 'error' : 'success'](`${type.name}: ${r.data.created || 0} creados, ${r.data.updated || 0} actualizados${errs ? `, ${errs} errores` : ''}`);
      setFile(null);
      document.getElementById(inputId).value = '';
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al importar');
    } finally { setUploading(false); }
  };

  return (
    <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-4 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <span className="shrink-0 w-7 h-7 rounded-full bg-emerald-600 text-white text-sm font-bold flex items-center justify-center">{type.order}</span>
        <div>
          <h2 className="font-semibold text-slate-800">{type.name}</h2>
          <p className="text-xs text-slate-500 mt-0.5">{type.desc}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 mt-auto">
        <button onClick={downloadTemplate} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-slate-700 text-white rounded-lg">
          <HiOutlineArrowDownTray className="w-4 h-4" /> Plantilla
        </button>
        <label htmlFor={inputId} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-slate-100 text-slate-700 rounded-lg cursor-pointer border border-slate-200">
          <HiOutlineArrowUpTray className="w-4 h-4" /> {file ? file.name : 'Elegir archivo…'}
        </label>
        <input id={inputId} type="file" accept=".xlsx" className="hidden" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        <button onClick={upload} disabled={!file || uploading} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-emerald-600 text-white rounded-lg disabled:opacity-40">
          <HiOutlineCloudArrowUp className="w-4 h-4" /> {uploading ? 'Importando…' : 'Importar'}
        </button>
      </div>
      {result && (
        <div className="text-xs rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-1">
          <p className="flex items-center gap-1.5 text-emerald-700 font-medium">
            <HiOutlineCheckCircle className="w-4 h-4" /> {result.created || 0} creados · {result.updated || 0} actualizados {result.total ? `· ${result.total} filas leídas` : ''}
          </p>
          {!!result.errors?.length && (
            <div className="text-rose-700">
              <p className="flex items-center gap-1.5 font-medium"><HiOutlineExclamationTriangle className="w-4 h-4" /> {result.errors.length} filas NO importadas:</p>
              <ul className="list-disc ml-5 max-h-40 overflow-y-auto">
                {result.errors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </div>
          )}
          {!!result.warnings?.length && (
            <div className="text-amber-700">
              <p className="flex items-center gap-1.5 font-medium"><HiOutlineExclamationTriangle className="w-4 h-4" /> {result.warnings.length} advertencias (la fila sí se importó):</p>
              <ul className="list-disc ml-5 max-h-40 overflow-y-auto">
                {result.warnings.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function DataImport() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Importación de datos</h1>
        <p className="text-sm text-slate-500 mt-1">
          Carga masiva por plantillas Excel para la migración desde Contífico o la carga inicial real.
          Descarga la plantilla, llénala (cada una trae una hoja de <b>Instrucciones</b>) y súbela.
          Si un código o identificación ya existe, la fila <b>actualiza</b> el registro (no duplica).
        </p>
      </div>
      <div className="bg-amber-50 border border-amber-200 text-amber-800 text-xs rounded-xl px-4 py-3">
        <b>Orden recomendado:</b> 1) Plan de cuentas → 2) Categorías → 3) Productos → 4) Activos → 5) Empleados → 6) Proveedores → 7) Clientes.
        Las plantillas que llevan cuentas contables usan el <b>código</b> de la cuenta según el plan importado.
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {TYPES.map((t) => <ImportCard key={t.key} type={t} />)}
      </div>
    </div>
  );
}
