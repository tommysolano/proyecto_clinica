const router = require('express').Router();
const { getPatients, getPatient, createPatient, updatePatient, deletePatient } = require('../controllers/patientController');
const { auth } = require('../middleware/auth');

router.use(auth);

router.get('/', getPatients);
router.get('/:id', getPatient);
router.post('/', createPatient);
router.put('/:id', updatePatient);
router.delete('/:id', deletePatient);

module.exports = router;
