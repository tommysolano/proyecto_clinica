import { HiOutlineDocumentText, HiOutlineRocketLaunch } from 'react-icons/hi2';

export default function Invoicing() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Facturación Electrónica</h1>
        <p className="text-sm text-slate-500 mt-1">Integración con el SRI de Ecuador</p>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-emerald-100 p-12 text-center max-w-2xl mx-auto">
        <div className="w-20 h-20 bg-gradient-to-br from-emerald-100 to-teal-100 rounded-2xl flex items-center justify-center mx-auto mb-6">
          <HiOutlineDocumentText className="w-10 h-10 text-emerald-600" />
        </div>

        <h2 className="text-xl font-bold text-slate-800 mb-3">Próximamente</h2>

        <p className="text-slate-500 mb-8 max-w-md mx-auto leading-relaxed">
          El módulo de facturación electrónica con el SRI de Ecuador está en desarrollo.
          Incluirá emisión de facturas, notas de crédito, firma electrónica y generación del RIDE.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-lg mx-auto mb-8">
          {[
            { title: 'Facturas electrónicas', desc: 'Emisión y autorización con el SRI' },
            { title: 'Notas de crédito', desc: 'Anulación parcial o total' },
            { title: 'Firma electrónica', desc: 'Firma digital con archivo .p12' },
            { title: 'RIDE (PDF)', desc: 'Representación impresa del comprobante' },
          ].map((item) => (
            <div key={item.title} className="bg-emerald-50/50 rounded-xl p-4 text-left border border-emerald-100">
              <p className="text-sm font-semibold text-slate-700">{item.title}</p>
              <p className="text-xs text-slate-500 mt-1">{item.desc}</p>
            </div>
          ))}
        </div>

        <div className="inline-flex items-center gap-2 bg-emerald-50 text-emerald-700 px-5 py-2.5 rounded-full text-sm font-medium">
          <HiOutlineRocketLaunch className="w-4 h-4" />
          En desarrollo — Fase 2
        </div>
      </div>
    </div>
  );
}
