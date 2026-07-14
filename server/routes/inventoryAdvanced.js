const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const { requireCap } = require('../utils/permissions');
const c = require('../controllers/inventoryAdvancedController');

router.use(auth, requireClinic);

// Quién puede ASOMARSE al inventario (cantidades). Los COSTOS se filtran dentro, en el
// controlador: sin `inventory.costs` los importes no salen del servidor.
const verInventario = requireRole('admin', 'contabilidad', 'cajero', 'enfermeria');

// Bodegas
router.get('/warehouses', verInventario, requireCap('warehouse.view'), c.listWarehouses);
router.post('/warehouses', requireRole('admin', 'contabilidad'), requireCap('warehouse.manage'), c.createWarehouse);
router.put('/warehouses/:id', requireRole('admin', 'contabilidad'), requireCap('warehouse.manage'), c.updateWarehouse);
router.delete('/warehouses/:id', requireRole('admin'), c.deleteWarehouse);

// Categorías
router.get('/categories', verInventario, c.listCategories);
router.post('/categories', requireRole('admin', 'contabilidad'), c.createCategory);
router.put('/categories/:id', requireRole('admin', 'contabilidad'), c.updateCategory);
router.delete('/categories/:id', requireRole('admin'), c.deleteCategory);

// Kardex: las CANTIDADES las ve quien trabaja con el inventario; los COSTOS solo quien puede.
router.get('/kardex', verInventario, requireCap('inventory.view'), c.getKardex);
router.get('/kardex.xlsx', verInventario, requireCap('inventory.export'), c.kardexExcel);
router.get('/warehouse-stock', verInventario, requireCap('inventory.view'), c.warehouseStock);
router.get('/transfers', verInventario, requireCap('inventory.view'), c.listTransfers);
router.post('/transfer', requireRole('admin', 'contabilidad'), c.transferStock);

// Toma física: contar la puede hacer quien está en la bodega; CONFIRMAR (que genera el asiento
// de ajuste) es una decisión contable.
router.get('/counts', verInventario, requireCap('inventory.view'), c.listCounts);
router.post('/counts', verInventario, requireCap('count.start'), c.startCount);
router.put('/counts/:id', verInventario, requireCap('count.edit'), c.updateCount);
router.post('/counts/:id/confirm', verInventario, requireCap('count.confirm'), c.confirmCount);

// Activos fijos
router.get('/assets', requireRole('admin', 'contabilidad'), c.listAssets);
router.get('/assets/:id', requireRole('admin', 'contabilidad'), c.getAsset);
router.post('/assets', requireRole('admin', 'contabilidad'), c.createAsset);
router.put('/assets/:id', requireRole('admin', 'contabilidad'), c.updateAsset);
router.post('/assets/:id/dispose', requireRole('admin', 'contabilidad'), c.disposeAsset);
router.delete('/assets/:id', requireRole('admin'), c.deleteAsset);
router.post('/assets/run-depreciation', requireRole('admin', 'contabilidad'), c.runDepreciation);

// Importación
router.post('/import/products', requireRole('admin', 'contabilidad'), c.importProducts);
router.post('/import/assets', requireRole('admin', 'contabilidad'), c.importAssets);
// Carga masiva por plantilla Excel
router.get('/template/products', requireRole('admin', 'contabilidad'), c.downloadProductTemplate);
router.post('/import/products-excel', requireRole('admin', 'contabilidad'), c.uploadMiddleware, c.importProductsExcel);

module.exports = router;
