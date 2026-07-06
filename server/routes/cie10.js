const router = require('express').Router();
const Cie10 = require('../models/Cie10');
const { auth, requireClinic } = require('../middleware/auth');

router.use(auth, requireClinic);

// GET /api/cie10?search=texto — busca por código o descripción (máx 50).
router.get('/', async (req, res) => {
  try {
    const q = String(req.query.search || '').trim();
    const filter = q
      ? {
          $or: [
            { code: { $regex: q, $options: 'i' } },
            { description: { $regex: q, $options: 'i' } },
          ],
        }
      : {};
    const results = await Cie10.find(filter)
      .sort({ code: 1 })
      .limit(50)
      .select('code description')
      .lean();
    res.json(results);
  } catch (error) {
    res.status(500).json({ message: 'Error al buscar CIE-10', error: error.message });
  }
});

module.exports = router;
