const Discount = require('../models/Discount');
const Patient = require('../models/Patient');
const Sale = require('../models/Sale');
const { companyClinicIds } = require('./companyCostCenters');
const { descuentoDeLinea } = require('../utils/productDiscount');

const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
const dateKey = (d) => d ? new Date(d).toISOString().slice(0, 10) : '';

async function calculateDiscounts({ clinicId, patientId, items, products, priceOf, now = new Date(), session = null }) {
  const ids = await companyClinicIds(clinicId, session);
  const query = (q) => (session ? q.session(session) : q);
  const rules = await query(Discount.find({ clinic: { $in: ids }, active: true }).sort({ createdAt: 1, _id: 1 })).lean();
  const patient = patientId ? await query(Patient.findById(patientId).select('birthDate')).lean() : null;
  const hasSale = patientId ? await query(Sale.exists({ clinic: { $in: ids }, patient: patientId, status: 'completada' })) : null;
  const ec = new Date(now.getTime() - 5 * 3600000);
  const day = ec.toISOString().slice(0, 10);
  const time = ec.toISOString().slice(11, 16);
  const birth = patient?.birthDate ? new Date(patient.birthDate) : null;
  const leap = (ec.getUTCFullYear() % 4 === 0 && ec.getUTCFullYear() % 100 !== 0) || ec.getUTCFullYear() % 400 === 0;
  const birthday = birth && birth.getUTCMonth() === ec.getUTCMonth() && (birth.getUTCDate() === ec.getUTCDate()
    || (!leap && ec.getUTCMonth() === 1 && ec.getUTCDate() === 28 && birth.getUTCDate() === 29));
  const amount = money(items.reduce((sum, item) => sum + priceOf(products.get(String(item.product)), item) * Number(item.quantity || 0), 0));
  const eligible = rules.filter((r) => {
    if (r.startDate && day < dateKey(r.startDate)) return false;
    if (r.endDate && day > dateKey(r.endDate)) return false;
    const overnight = r.startTime && r.endTime && r.startTime > r.endTime;
    const scheduleDay = overnight && time <= r.endTime ? (ec.getUTCDay() + 6) % 7 : ec.getUTCDay();
    if (r.daysOfWeek?.length && !r.daysOfWeek.includes(scheduleDay)) return false;
    if (overnight) {
      if (time < r.startTime && time > r.endTime) return false;
    } else {
      if (r.startTime && time < r.startTime) return false;
      if (r.endTime && time > r.endTime) return false;
    }
    if (r.clinics?.length && !r.clinics.some((id) => String(id) === String(clinicId))) return false;
    if (Number(r.minAmount) > amount || (r.maxUses > 0 && (r.usedCount || 0) >= r.maxUses)) return false;
    if (r.audience === 'nuevos' && (!patient || hasSale)) return false;
    if (r.audience === 'recurrentes' && (!patient || !hasSale)) return false;
    if (r.audience === 'cumpleanos' && !birthday) return false;
    return true;
  });
  return items.map((item) => {
    const product = products.get(String(item.product));
    const unitPrice = priceOf(product, item);
    const gross = Math.max(0, money(unitPrice * Number(item.quantity || 0)));
    let discount = descuentoDeLinea(product, unitPrice, item.quantity);
    const applied = [];
    for (const rule of eligible) {
      if (rule.scope !== 'all' && !rule.products?.some((id) => String(id) === String(item.product))) continue;
      const value = rule.type === 'percentage' ? money(gross * Number(rule.value || 0) / 100)
        : money(Number(rule.value || 0) * Number(item.quantity || 0));
      const contribution = Math.min(Math.max(0, value), money(gross - discount));
      if (contribution > 0) { discount = money(discount + contribution); applied.push({ id: String(rule._id), name: rule.name, amount: contribution }); }
    }
    return { discount, applied };
  });
}

module.exports = { calculateDiscounts };
