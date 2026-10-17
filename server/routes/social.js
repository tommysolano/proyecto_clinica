const router = require('express').Router();
const ctrl = require('../controllers/socialController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

// PÚBLICA: la red social redirige aquí el navegador tras dar permisos. Quién lo
// pidió viaja en el `state` firmado (utils/social/oauth), no en la sesión.
router.get('/oauth/:network/callback', ctrl.oauthCallback);

router.use(auth, requireClinic);
// CRM global: opera sobre la clínica ancla del call center (no por empresa ni sucursal).
router.use(require('../middleware/callCenterScope'));

const ROLES = ['admin', 'marketing'];
const team = requireRole(...ROLES);
const adminOnly = requireRole('admin');

router.get('/posts', team, ctrl.listPosts);
router.post('/posts', team, ctrl.createPost);
router.get('/posts/:id', team, ctrl.getPost);
router.put('/posts/:id', team, ctrl.updatePost);
router.delete('/posts/:id', team, ctrl.removePost);
router.post('/posts/:id/approve', adminOnly, ctrl.approvePost);
router.post('/posts/:id/reject', adminOnly, ctrl.rejectPost);
router.post('/posts/:id/unschedule', team, ctrl.unschedulePost);
router.post('/posts/:id/duplicate', team, ctrl.duplicatePost);
router.post('/posts/:id/notes', team, ctrl.addNote);
router.post('/posts/:id/targets/:targetId/retry', team, ctrl.retryTarget);
router.post('/posts/:id/targets/:targetId/manual', team, ctrl.markTargetManual);

router.post('/media', team, ctrl.mediaUploadMiddleware, ctrl.uploadMedia);
router.get('/team', team, ctrl.listTeam);

router.get('/accounts', team, ctrl.listAccounts);
router.delete('/accounts/:id', team, ctrl.removeAccount);
router.post('/accounts/:id/check', team, ctrl.checkAccount);
router.get('/accounts/:id/tiktok-creator', team, ctrl.tiktokCreatorInfo);

router.get('/oauth/:network/url', team, ctrl.oauthUrl);
router.post('/meta/token', team, ctrl.metaManualToken);
router.get('/meta/pages', team, ctrl.metaPages);
router.post('/meta/accounts', team, ctrl.metaAddAccounts);

router.get('/config', team, ctrl.getConfig);
router.put('/config', adminOnly, ctrl.updateConfig);
router.put('/config/hashtag-groups', team, ctrl.updateHashtagGroups);

module.exports = router;
