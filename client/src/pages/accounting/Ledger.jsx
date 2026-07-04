import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineBookOpen, HiOutlineArrowTopRightOnSquare, HiOutlineBuildingLibrary } from 'react-icons/hi2';
import { fmt, fmtDate, startOfMonth, today } from './_utils';
import SearchableSelect from '../../components/SearchableSelect';
import Modal from '../../components/Modal';

// Mapa de documento origen (sourceModel del asiento) → etiqueta legible y, cuando
// existe deep-link real en la página destino, la ruta + `deep:true`. Solo los
// `deep:true` muestran el botón "Ir a…" (la página lee ?doc=<id> y abre el
// documento); el resto se consulta desde el modal del asiento.
const SOURCE_ROUTES = {
  Sale: { path: '/sales', label: 'Venta', deep: true },
  PurchaseInvoice: { path: '/accounting/purchases', label: 'Factura de compra', deep: true },
  FixedAsset: { path: '/accounting/assets', label: 'Activo fijo (depreciación)', deep: true },
  Payroll: { path: '/accounting/payroll', label: 'Nómina', deep: true },
  // Sin deep-link (solo etiqueta): el asiento se ve en el modal.
  Invoice: { label: 'Factura de venta' },
  Payment: { label: 'Pago / Cobro' },
  BankTransaction: { label: 'Movimiento bancario' },
  CashDeposit: { label: 'Depósito de efectivo' },
  Reconciliation: { label: 'Conciliación' },
  CashClosing: { label: 'Cierre de caja' },
  CashMovement: { label: 'Movimiento de caja' },
  CommissionPosting: { label: 'Comisiones del personal' },
  CreditDebitNote: { label: 'Nota de crédito / débito' },
  RetentionVoucher: { label: 'Comprobante de retención' },
  DeferredIncome: { label: 'Ingreso diferido' },
  CardSettlement: { label: 'Liquidación de tarjeta' },
  CreditCardBatch: { label: 'Lote de tarjeta' },
  EmployeeDeduction: { label: 'Deducción de empleado' },
  PhysicalCount: { label: 'Toma física de inventario' },
  JournalEntry: { label: 'Asiento (reversa)' },
};

const sourceLabel = (row) => SOURCE_ROUTES[row.sourceModel]?.label || row.source || 'Asiento manual';

export default function Ledger() {
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState([]);
  const [account, setAccount] = useState('');
  const [startDate, setStart] = useState(startOfMonth());
  const [endDate, setEnd] = useState(today());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [entry, setEntry] = useState(null); // asiento abierto en el modal

  useEffect(() => {
    // Se cargan TODAS las cuentas activas (incluidas las padre/agrupadoras) para
    // permitir consultar saldos consolidados de una rama del plan de cuentas.
    api.get('/chart-of-accounts', { params: { active: true } }).then((r) => setAccounts(r.data || []));
  }, []);

  const load = async () => {
    if (!account) return toast.error('Seleccione cuenta');
    setLoading(true);
    try {
      const r = await api.get('/journal-entries/ledger', { params: { account, startDate, endDate } });
      setData(r.data);
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error');
    } finally {
      setLoading(false);
    }
  };

  const openEntry = async (row) => {
    if (!row.entryId) return;
    try {
      const r = await api.get(`/journal-entries/${row.entryId}`);
      setEntry({ ...r.data, _row: row });
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo abrir el asiento');
    }
  };

  const goToSource = (e) => {
    const map = SOURCE_ROUTES[e?.sourceModel];
    // Solo navegamos a documentos con deep-link real (la página abre el ?doc=<id>).
    if (!map?.deep || !e.sourceRef) return;
    navigate(`${map.path}?doc=${e.sourceRef}`);
  };

  const bankSummary = data?.bankSummary;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineBookOpen className="text-emerald-600" /> Libro Mayor</h1>

      <div className="bg-white p-3 rounded-xl shadow-sm flex gap-2 flex-wrap items-end">
        <div className="flex-1 min-w-64">
          <label className="text-xs text-slate-500">Cuenta</label>
          <SearchableSelect
            options={accounts}
            value={account}
            onChange={setAccount}
            getLabel={(a) => `${a.code} - ${a.name}${a.allowsMovement === false ? ' (agrupadora)' : ''}`}
            getSearchText={(a) => `${a.code} ${a.name}`}
            placeholder="Seleccione una cuenta (padre o de movimiento)…"
            searchPlaceholder="Buscar por código o nombre…"
            allowClear
          />
        </div>
        <div><label className="text-xs text-slate-500">Desde</label><input type="date" value={startDate} onChange={(e) => setStart(e.target.value)} className="border border-slate-200 rounded-xl px-3.5 py-2.5" /></div>
        <div><label className="text-xs text-slate-500">Hasta</label><input type="date" value={endDate} onChange={(e) => setEnd(e.target.value)} className="border border-slate-200 rounded-xl px-3.5 py-2.5" /></div>
        <button onClick={load} disabled={loading} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 disabled:opacity-60">{loading ? 'Consultando…' : 'Consultar'}</button>
      </div>

      {data && (
        <div className="space-y-4">
          <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
            <div className="p-3 bg-slate-50 text-sm flex gap-x-5 gap-y-1 flex-wrap items-center">
              <span>Cuenta: <b>{data.account?.code} - {data.account?.name}</b></span>
              {data.isParent && (
                <span className="px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 text-[11px]">
                  Cuenta padre · {data.includedAccounts?.length || 0} cuentas
                </span>
              )}
              <span>Saldo inicial: <b>${fmt(data.opening)}</b></span>
              <span>Total débito: <b className="text-emerald-700">${fmt(data.debit)}</b></span>
              <span>Total crédito: <b className="text-rose-600">${fmt(data.credit)}</b></span>
              <span>Movimiento: <b>${fmt(data.movement)}</b></span>
              <span className="ml-auto">Saldo final: <b className="text-lg">${fmt(data.closing)}</b></span>
            </div>

            {data.isParent && data.includedAccounts?.length > 0 && (
              <div className="px-3 py-2 border-b border-slate-100 text-[11px] text-slate-500 flex flex-wrap gap-x-3 gap-y-0.5">
                <span className="font-semibold text-slate-600">Incluye:</span>
                {data.includedAccounts.map((a) => (
                  <span key={a._id} className="font-mono">{a.code}</span>
                ))}
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="tbl">
                <thead className="bg-slate-100 text-xs uppercase"><tr>
                  <th className="px-2 py-1 text-left">Fecha</th>
                  <th className="px-2 py-1 text-left">Asiento</th>
                  <th className="px-2 py-1 text-left">Cuenta</th>
                  <th className="px-2 py-1 text-left">Descripción</th>
                  <th className="px-2 py-1 text-left">Origen</th>
                  <th className="px-2 py-1 text-right">Débito</th>
                  <th className="px-2 py-1 text-right">Crédito</th>
                  <th className="px-2 py-1 text-right">Saldo</th>
                </tr></thead>
                <tbody>
                  {(data.rows || []).map((m, i) => (
                    <tr
                      key={`${m.entryId}-${i}`}
                      className="border-t hover:bg-emerald-50/60 cursor-pointer"
                      onClick={() => openEntry(m)}
                      title="Ver asiento / documento origen"
                    >
                      <td className="px-2 py-1">{fmtDate(m.date)}</td>
                      <td className="px-2 py-1 font-mono text-xs text-emerald-700 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1">{m.number}<HiOutlineArrowTopRightOnSquare className="w-3 h-3 opacity-60" /></span>
                      </td>
                      <td className="px-2 py-1 font-mono text-[11px] text-slate-600 whitespace-nowrap">{m.accountCode}</td>
                      <td className="px-2 py-1 text-xs">{m.description}</td>
                      <td className="px-2 py-1 text-xs text-slate-500">{sourceLabel(m)}</td>
                      <td className="px-2 py-1 text-right font-mono">{m.debit ? fmt(m.debit) : ''}</td>
                      <td className="px-2 py-1 text-right font-mono">{m.credit ? fmt(m.credit) : ''}</td>
                      <td className="px-2 py-1 text-right font-mono font-semibold">{fmt(m.saldo)}</td>
                    </tr>
                  ))}
                  {(data.rows || []).length === 0 && (
                    <tr><td colSpan={8} className="px-2 py-4 text-center text-slate-400 text-xs">Sin movimientos en el rango seleccionado.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {bankSummary && (
            <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
              <div className="p-3 bg-sky-50 text-sm flex items-center gap-2 border-b border-sky-100">
                <HiOutlineBuildingLibrary className="text-sky-600" />
                <b className="text-slate-700">Resumen bancario</b>
                <span className="text-xs text-slate-500">Cuentas bancarias asociadas a la cuenta consultada</span>
              </div>
              <div className="overflow-x-auto">
                <table className="tbl">
                  <thead className="bg-slate-100 text-xs uppercase"><tr>
                    <th className="px-2 py-1 text-left">Cuenta bancaria</th>
                    <th className="px-2 py-1 text-left">Banco</th>
                    <th className="px-2 py-1 text-left">N° cuenta</th>
                    <th className="px-2 py-1 text-right">Saldo inicial</th>
                    <th className="px-2 py-1 text-right">Entradas</th>
                    <th className="px-2 py-1 text-right">Salidas</th>
                    <th className="px-2 py-1 text-right">Saldo final</th>
                  </tr></thead>
                  <tbody>
                    {bankSummary.accounts.map((b) => (
                      <tr key={b.bankAccountId} className="border-t hover:bg-sky-50/60">
                        <td className="px-2 py-1">{b.name}</td>
                        <td className="px-2 py-1 text-xs">{b.bank}</td>
                        <td className="px-2 py-1 font-mono text-xs">{b.accountNumber}</td>
                        <td className="px-2 py-1 text-right font-mono">{fmt(b.opening)}</td>
                        <td className="px-2 py-1 text-right font-mono text-emerald-700">{fmt(b.inflow)}</td>
                        <td className="px-2 py-1 text-right font-mono text-rose-600">{fmt(b.outflow)}</td>
                        <td className="px-2 py-1 text-right font-mono font-semibold">{fmt(b.closing)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-slate-50 font-semibold text-sm"><tr>
                    <td className="px-2 py-1.5" colSpan={3}>Consolidado</td>
                    <td className="px-2 py-1.5 text-right font-mono">{fmt(bankSummary.totals.opening)}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-emerald-700">{fmt(bankSummary.totals.inflow)}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-rose-600">{fmt(bankSummary.totals.outflow)}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{fmt(bankSummary.totals.closing)}</td>
                  </tr></tfoot>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      <Modal isOpen={!!entry} onClose={() => setEntry(null)} title={`Asiento ${entry?.number || ''}`} size="xl">
        {entry && (
          <div className="space-y-3">
            <div className="text-sm flex flex-wrap gap-x-4 gap-y-1">
              <span><b>Fecha:</b> {fmtDate(entry.date)}</span>
              <span><b>Origen:</b> {SOURCE_ROUTES[entry.sourceModel]?.label || entry.source}</span>
              {entry.status && <span><b>Estado:</b> {entry.status}</span>}
            </div>
            {entry.description && <p className="text-sm text-slate-600">{entry.description}</p>}

            {SOURCE_ROUTES[entry.sourceModel]?.deep && entry.sourceRef && (
              <button
                onClick={() => goToSource(entry)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-slate-700 text-white rounded-lg"
              >
                <HiOutlineArrowTopRightOnSquare className="w-4 h-4" />
                Ir a {SOURCE_ROUTES[entry.sourceModel].label}
              </button>
            )}

            <table className="tbl border">
              <thead className="bg-slate-100"><tr>
                <th className="p-2 text-left">Código</th>
                <th className="p-2 text-left">Cuenta</th>
                <th className="p-2 text-right">Débito</th>
                <th className="p-2 text-right">Crédito</th>
              </tr></thead>
              <tbody>
                {(entry.lines || []).map((l, i) => {
                  const affected = entry._row && String(l.account?._id || l.account) === String(entry._row.accountId);
                  return (
                    <tr key={i} className={`border-t ${affected ? 'bg-emerald-50' : ''}`}>
                      <td className="p-2 font-mono text-xs">{l.accountCode || l.account?.code}</td>
                      <td className="p-2">{(l.accountName || l.account?.name)}{l.description ? ` - ${l.description}` : ''}</td>
                      <td className="p-2 text-right font-mono">{l.debit ? fmt(l.debit) : ''}</td>
                      <td className="p-2 text-right font-mono">{l.credit ? fmt(l.credit) : ''}</td>
                    </tr>
                  );
                })}
                <tr className="font-bold bg-slate-50">
                  <td colSpan={2} className="p-2 text-right">Totales</td>
                  <td className="p-2 text-right font-mono">{fmt(entry.totalDebit)}</td>
                  <td className="p-2 text-right font-mono">{fmt(entry.totalCredit)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </div>
  );
}
