const mongoose = require('mongoose');
const Company = require('../models/Company');
const Clinic = require('../models/Clinic');
const Product = require('../models/Product');
const ChartOfAccount = require('../models/ChartOfAccount');
const InventoryCategory = require('../models/InventoryCategory');
const AppointmentServiceItem = require('../models/AppointmentServiceItem');
const {
  ensureCompanyCache, invalidateCompanyCache, userCompanyIds, clinicsOfCompanySync,
} = require('../utils/companies');
const { veTodasLasEmpresas } = require('../utils/clinicScope');

const CAMPOS = ['name', 'ruc', 'razonSocial', 'nombreComercial', 'logoUrl', 'active'];
const pick = (body) => Object.fromEntries(CAMPOS.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));

/**
 * Empresas visibles, cada una con sus sucursales. El super-admin y el CRM (call center
 * y marketing, que agendan para todas) ven todas; el resto, las suyas. Es lo que pinta
 * el selector «empresa → sucursal» al agendar.
 */
exports.list = async (req, res) => {
  try {
    await ensureCompanyCache();
    const todas = req.user.isSuperAdmin || veTodasLasEmpresas(req);
    const ids = todas ? null : userCompanyIds(req.user);
    const filter = ids ? { _id: { $in: ids } } : {};
    if (req.query.active !== 'all') filter.active = { $ne: false };
    const [companies, clinics] = await Promise.all([
      Company.find(filter).sort({ isDefault: -1, name: 1 }).lean(),
      Clinic.find({}).select('_id name nombreComercial active company appointmentSlotMinutes').sort({ name: 1 }).lean(),
    ]);
    res.json(companies.map((company) => ({
      ...company,
      clinics: clinics.filter((clinic) => String(clinic.company) === String(company._id)),
    })));
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener las empresas', error: error.message });
  }
};

exports.create = async (req, res) => {
  try {
    const data = pick(req.body);
    if (!String(data.name || '').trim()) return res.status(400).json({ message: 'El nombre es requerido' });
    const company = await Company.create(data);
    invalidateCompanyCache();
    res.status(201).json(company);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.update = async (req, res) => {
  try {
    const company = await Company.findByIdAndUpdate(req.params.id, { $set: pick(req.body) }, { new: true, runValidators: true });
    if (!company) return res.status(404).json({ message: 'Empresa no encontrada' });
    invalidateCompanyCache();
    res.json(company);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

/** Sucursal dueña del catálogo de una empresa: su sucursal activa más antigua. */
async function catalogOwner(companyId) {
  return Clinic.findOne({ company: companyId, active: { $ne: false } }).sort({ createdAt: 1 }).lean();
}

/**
 * COPIAR EL CATÁLOGO de otra empresa (productos, servicios y programas, con precios,
 * IVA, composición y la configuración de agenda de cada servicio).
 *
 * Después de copiar son INDEPENDIENTES: cada empresa cambia el suyo. Por eso es una
 * copia y no una referencia. Lo que se ajusta al cruzar de empresa:
 *   · Stock: arranca en cero (el inventario físico es de cada empresa).
 *   · Cuentas y categoría contable: las de la empresa destino con el MISMO código; si
 *     no tiene ese código quedan vacías para que la definan.
 *   · Disponibilidad por sucursal: en todas las de la empresa destino.
 *   · Lo que ya existe en el destino con el mismo código no se toca (se puede repetir
 *     la copia sin duplicar).
 */
exports.copyCatalog = async (req, res) => {
  try {
    const target = await Company.findById(req.params.id).lean();
    const source = await Company.findById(req.body.fromCompany).lean();
    if (!target || !source) return res.status(404).json({ message: 'Empresa no encontrada' });
    if (String(target._id) === String(source._id)) return res.status(400).json({ message: 'Elige otra empresa de origen' });
    await ensureCompanyCache();
    const owner = await catalogOwner(target._id);
    if (!owner) return res.status(400).json({ message: 'La empresa destino necesita al menos una sucursal activa para recibir el catálogo.' });

    const sourceClinics = clinicsOfCompanySync(source._id, { includeInactive: true });
    const targetClinics = clinicsOfCompanySync(target._id, { includeInactive: true });
    const [products, existing, accounts, sourceAccounts, categories, sourceCategories] = await Promise.all([
      Product.find({ clinic: { $in: sourceClinics } }).lean(),
      Product.find({ clinic: { $in: targetClinics } }).select('code').lean(),
      ChartOfAccount.find({ clinic: owner._id }).select('code').lean(),
      ChartOfAccount.find({ clinic: { $in: sourceClinics } }).select('code').lean(),
      InventoryCategory.find({ clinic: owner._id }).select('code').lean(),
      InventoryCategory.find({ clinic: { $in: sourceClinics } }).select('code').lean(),
    ]);
    // Por código: el id de la cuenta/categoría de origen → la del destino con ese código.
    const remap = (sourceRows, targetRows) => {
      const byCode = new Map(targetRows.map((row) => [String(row.code), row._id]));
      return new Map(sourceRows.map((row) => [String(row._id), byCode.get(String(row.code)) || null]));
    };
    const accountMap = remap(sourceAccounts, accounts);
    const categoryMap = remap(sourceCategories, categories);
    const taken = new Set(existing.map((product) => String(product.code)));

    // Un código repetido entre sucursales de origen se copia una vez (la más antigua manda).
    const toCopy = [];
    for (const product of products.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))) {
      if (taken.has(String(product.code))) continue;
      taken.add(String(product.code));
      toCopy.push(product);
    }
    const newIds = new Map(toCopy.map((product) => [String(product._id), new mongoose.Types.ObjectId()]));
    // Las referencias internas (programas, insumos de un servicio, componentes de un
    // suero) apuntan a la copia; si el producto referido no se copió, a la del destino
    // con el mismo código.
    const targetByCode = new Map(existing.map((product) => [String(product.code), product._id]));
    const sourceCode = new Map(products.map((product) => [String(product._id), String(product.code)]));
    const ref = (id) => newIds.get(String(id)) || targetByCode.get(sourceCode.get(String(id))) || null;
    const lines = (rows) => (rows || []).map((row) => ({ ...row, product: ref(row.product) })).filter((row) => row.product);

    const docs = toCopy.map((product) => {
      const { _id, __v, createdAt, updatedAt, ...rest } = product;
      return {
        ...rest,
        _id: newIds.get(String(_id)),
        clinic: owner._id,
        stock: 0,
        stockByClinic: [],
        availableInClinics: [],
        programServices: lines(rest.programServices),
        serviceItems: lines(rest.serviceItems),
        components: lines(rest.components),
        inventoryAccount: rest.inventoryAccount ? accountMap.get(String(rest.inventoryAccount)) || null : null,
        expenseAccount: rest.expenseAccount ? accountMap.get(String(rest.expenseAccount)) || null : null,
        incomeAccount: rest.incomeAccount ? accountMap.get(String(rest.incomeAccount)) || null : null,
        inventoryCategory: rest.inventoryCategory ? categoryMap.get(String(rest.inventoryCategory)) || null : null,
      };
    });
    for (let offset = 0; offset < docs.length; offset += 500) {
      await Product.insertMany(docs.slice(offset, offset + 500), { ordered: false });
    }

    // La configuración de agenda de cada servicio (duración, enfermería, suero de serie)
    // viaja con él: la sincronización crea los registros de agenda del destino y aquí se
    // les copia lo que el de origen tenía configurado.
    const { sincronizarServiciosInventario } = require('../utils/serviciosInventario');
    await sincronizarServiciosInventario({ force: true });
    const [sourceItems, targetItems] = await Promise.all([
      AppointmentServiceItem.find({ company: source._id }).lean(),
      AppointmentServiceItem.find({ company: target._id }).lean(),
    ]);
    const targetBySlug = new Map(targetItems.map((item) => [item.slug, item]));
    const itemOps = [];
    for (const item of sourceItems) {
      const copy = targetBySlug.get(item.slug);
      if (!copy || copy.durationMinutes || copy.nursingService || copy.autoSerum?.enabled) continue;
      itemOps.push({ updateOne: { filter: { _id: copy._id }, update: { $set: {
        color: item.color, nursingService: item.nursingService, durationMinutes: item.durationMinutes,
        autoSerum: item.autoSerum,
      } } } });
    }
    if (itemOps.length) await AppointmentServiceItem.bulkWrite(itemOps, { ordered: false });

    res.json({ copied: docs.length, skipped: products.length - docs.length, serviceSettings: itemOps.length });
  } catch (error) {
    res.status(500).json({ message: 'Error al copiar el catálogo', error: error.message });
  }
};
