import { useEffect, useMemo, useState } from 'react';
import api from '../api/axios';

const itemKey = (item) => String(item.item || item.name || '');

/** Estado compartido por los dos modales desde los que caja registra compras. */
export default function useAppointmentPurchase(appointment) {
  const [prescribedItems, setPrescribedItems] = useState([]);
  const [selected, setSelected] = useState(
    () => new Set((appointment?.prescribedItems || []).map(itemKey))
  );
  const [additionalItems, setAdditionalItems] = useState([]);
  const [itemsValue, setItemsValue] = useState(
    appointment?.itemsValue == null ? '' : String(appointment.itemsValue)
  );
  const [itemsMethod, setItemsMethod] = useState(appointment?.itemsMethod || '');
  const [products, setProducts] = useState([]);
  const [pickerKey, setPickerKey] = useState(0);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.get(`/clinical-records/by-appointment/${appointment._id}`),
      api.get('/products'),
    ])
      .then(([recordResponse, productsResponse]) => {
        if (!alive) return;
        const recipe = [];
        for (const followUp of recordResponse.data?.followUps || []) {
          for (const item of followUp.recetaItems || []) {
            if (item.isService || item.isSerum) continue;
            recipe.push({
              followUp: followUp._id,
              item: item._id,
              name: item.name || '',
              quantity: Number(item.quantity) > 0 ? Number(item.quantity) : 1,
            });
          }
        }
        setPrescribedItems(recipe);
        setProducts(
          (Array.isArray(productsResponse.data) ? productsResponse.data : [])
            .filter((product) => product.category === 'insumo')
        );
      })
      .catch(() => {
        if (!alive) return;
        setPrescribedItems([]);
        setProducts([]);
      });
    return () => { alive = false; };
  }, [appointment._id]);

  const chosenPrescription = useMemo(
    () => prescribedItems.filter((item) => selected.has(itemKey(item))),
    [prescribedItems, selected]
  );

  const togglePrescription = (item) => {
    const key = itemKey(item);
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const addProduct = (product) => {
    if (!product?._id) return;
    const productId = String(product._id);
    setAdditionalItems((previous) => {
      if (previous.some((item) => item.product === productId)) return previous;
      return [...previous, {
        product: productId,
        name: product.name || '',
        quantity: 1,
        price: Number(product.salePrice) || 0,
      }];
    });
    setPickerKey((key) => key + 1);
  };

  const changeQuantity = (productId, value) => {
    const quantity = Math.max(1, Math.min(9999, Number(value) || 1));
    setAdditionalItems((previous) => previous.map((item) => (
      item.product === productId ? { ...item, quantity } : item
    )));
  };

  const removeProduct = (productId) => {
    setAdditionalItems((previous) => previous.filter((item) => item.product !== productId));
  };

  const payload = () => ({
    items: [
      ...chosenPrescription.map((item) => ({ ...item, source: 'receta' })),
      ...additionalItems.map((item) => ({
        product: item.product,
        quantity: item.quantity,
        source: 'adicional',
      })),
    ],
    itemsValue: itemsValue === '' ? null : Number(itemsValue),
    itemsMethod,
  });

  const reset = () => {
    setSelected(new Set());
    setAdditionalItems([]);
    setItemsValue('');
    setItemsMethod('');
    setPickerKey((key) => key + 1);
  };

  return {
    prescribedItems,
    selected,
    chosenPrescription,
    additionalItems,
    itemsValue,
    itemsMethod,
    products,
    pickerKey,
    togglePrescription,
    addProduct,
    changeQuantity,
    removeProduct,
    setItemsValue,
    setItemsMethod,
    payload,
    reset,
  };
}
