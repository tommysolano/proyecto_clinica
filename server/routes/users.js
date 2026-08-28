const router = require('express').Router();
const {
  getUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  getDoctors,
  getNurses,
  getMySignatureCert,
  uploadMySignatureCert,
  deleteMySignatureCert,
  signatureCertUploadMiddleware,
  getStaffAssignments,
  updateStaffAssignments,
} = require('../controllers/userController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

router.get('/doctors', getDoctors);
// Para nombrar el turno de enfermería al asignar la atención. Lo consulta
// recepción/caja, no solo el admin.
router.get('/nurses', requireRole('admin', 'cajero', 'doctor', 'enfermero'), getNurses);
/**
 * FIRMA ELECTRÓNICA del usuario actual (.p12). Es un ajuste de SU cuenta, así
 * que no lleva `requireRole`: quien firma documentos es el profesional, y quien
 * decide subir su certificado es él. Lo que sí se controla es dónde se USA —
 * solo se firma con el certificado de quien redactó el documento.
 */
router.get('/me/signature-cert', getMySignatureCert);
router.post('/me/signature-cert', signatureCertUploadMiddleware, uploadMySignatureCert);
router.delete('/me/signature-cert', deleteMySignatureCert);
// Personal por sucursal: en qué sede trabaja cada médico, cajero y enfermero.
// Va ANTES de '/:id' — si no, Express leería "assignments" como un id.
router.get('/assignments', requireRole('admin'), getStaffAssignments);
router.put('/:id/assignments', requireRole('admin'), updateStaffAssignments);

router.get('/', requireRole('admin'), getUsers);
router.get('/:id', requireRole('admin'), getUser);
router.post('/', requireRole('admin'), createUser);
router.put('/:id', requireRole('admin'), updateUser);
router.delete('/:id', requireRole('admin'), deleteUser);

module.exports = router;
