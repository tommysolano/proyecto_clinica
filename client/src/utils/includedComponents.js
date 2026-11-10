export const totalIncluded = (items = []) => items.reduce((total, item) => total + (Number(item.quantity) || 0), 0);

export const includedLimit = (item) => item.includedMax == null
  ? null
  : Number(item.includedMax) * Number(item.quantity || 1);

export const remainingIncluded = (item, items = []) => {
  const limit = includedLimit(item);
  return limit == null ? null : Math.max(0, limit - totalIncluded(items));
};

export const boundedIncludedQuantity = (value, max) => {
  const digits = String(value).replace(/\D/g, '');
  return digits === '' ? '' : String(Math.min(Number(digits), Math.max(0, max)));
};
