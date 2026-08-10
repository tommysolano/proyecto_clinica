const router = require('express').Router();
const { searchCie10, count } = require('../utils/cie10Catalog');
const { auth, requireClinic } = require('../middleware/auth');

router.use(auth, requireClinic);

// GET /api/cie10?search=texto — busca en el catálogo completo cargado en memoria
// (sin tildes ni mayúsculas, por código o por enfermedad). `total` deja ver de
// un vistazo cuántos códigos tiene cargados el sistema.
router.get('/', async (req, res) => {
  try {
    const results = searchCie10(req.query.search, req.query.limit);
    res.set('X-Cie10-Total', String(count));
    res.json(results);
  } catch (error) {
    res.status(500).json({ message: 'Error al buscar CIE-10', error: error.message });
  }
});

module.exports = router;
