const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/inventoryAdvancedController');

router.use(auth, requireClinic);

// Bodegas
router.get('/warehouses', requireRole('admin', 'contabilidad'), c.listWarehouses);
router.post('/warehouses', requireRole('admin', 'contabilidad'), c.createWarehouse);
router.put('/warehouses/:id', requireRole('admin', 'contabilidad'), c.updateWarehouse);
router.delete('/warehouses/:id', requireRole('admin'), c.deleteWarehouse);

// Categorías
router.get('/categories', requireRole('admin', 'contabilidad'), c.listCategories);
router.post('/categories', requireRole('admin', 'contabilidad'), c.createCategory);
router.put('/categories/:id', requireRole('admin', 'contabilidad'), c.updateCategory);
router.delete('/categories/:id', requireRole('admin'), c.deleteCategory);

// Kardex y traslados
router.get('/kardex', requireRole('admin', 'contabilidad'), c.getKardex);
router.get('/warehouse-stock', requireRole('admin', 'contabilidad'), c.warehouseStock);
router.get('/transfers', requireRole('admin', 'contabilidad'), c.listTransfers);
router.post('/transfer', requireRole('admin', 'contabilidad'), c.transferStock);

// Toma física
router.get('/counts', requireRole('admin', 'contabilidad'), c.listCounts);
router.post('/counts', requireRole('admin', 'contabilidad'), c.startCount);
router.put('/counts/:id', requireRole('admin', 'contabilidad'), c.updateCount);
router.post('/counts/:id/confirm', requireRole('admin', 'contabilidad'), c.confirmCount);

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
