const ReviewRequest = require('../models/ReviewRequest');
const CallCenterConfig = require('../models/CallCenterConfig');

// ===================== Admin: listado + métricas =====================

exports.list = async (req, res) => {
  try {
    const filter = { clinic: req.clinicId };
    if (req.query.status) filter.status = req.query.status;
    const list = await ReviewRequest.find(filter)
      .populate('patient', 'firstName lastName phone')
      .sort({ createdAt: -1 })
      .limit(300);
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: 'Error al listar reseñas', error: err.message });
  }
};

exports.stats = async (req, res) => {
  try {
    const match = { clinic: req.clinicId };
    const [total, clicked, rated, redirected, ratingAgg] = await Promise.all([
      ReviewRequest.countDocuments(match),
      ReviewRequest.countDocuments({ ...match, status: { $in: ['clicked', 'rated', 'redirected'] } }),
      ReviewRequest.countDocuments({ ...match, rating: { $ne: null } }),
      ReviewRequest.countDocuments({ ...match, status: 'redirected' }),
      ReviewRequest.aggregate([
        { $match: { ...match, rating: { $ne: null } } },
        { $group: { _id: null, avg: { $avg: '$rating' } } },
      ]),
    ]);
    res.json({
      total,
      clicked,
      rated,
      redirected, // promotores enviados a Google
      avgRating: ratingAgg[0]?.avg ? Number(ratingAgg[0].avg.toFixed(2)) : null,
    });
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

// ===================== Público: página de calificación =====================

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Página de estrellas autocontenida (sin SPA): el paciente toca una estrella y
// se envía por fetch; si es promotor, el JS redirige a Google.
function ratingPage({ clinicName }) {
  const name = escapeHtml(clinicName || 'nuestra clínica');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Tu opinión</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:48px 20px;text-align:center;color:#1f2937;background:#f8fafc}
  h2{font-size:20px;margin-bottom:8px}
  p{color:#6b7280;font-size:14px}
  .stars{font-size:44px;margin:24px 0;cursor:pointer;user-select:none}
  .star{color:#d1d5db;transition:transform .1s}
  .star:hover,.star.on{color:#f59e0b}
  .star:active{transform:scale(1.2)}
  textarea{width:100%;border:1px solid #e5e7eb;border-radius:10px;padding:10px;font-size:14px;margin-top:8px;display:none;box-sizing:border-box}
  button{margin-top:14px;background:#059669;color:#fff;border:none;border-radius:10px;padding:12px 20px;font-size:15px;cursor:pointer;display:none}
  .done{font-size:16px;color:#059669;margin-top:24px;display:none}
</style></head><body>
  <h2>¿Cómo fue tu experiencia en ${name}?</h2>
  <p>Tu opinión nos ayuda a mejorar.</p>
  <div class="stars" id="stars">
    ${[1, 2, 3, 4, 5].map((n) => `<span class="star" data-n="${n}">★</span>`).join('')}
  </div>
  <textarea id="fb" rows="3" placeholder="Cuéntanos qué podemos mejorar (opcional)"></textarea>
  <button id="send">Enviar</button>
  <div class="done" id="done">¡Gracias por tu opinión! 🙏</div>
<script>
  var rating=0;
  var stars=document.querySelectorAll('.star');
  var fb=document.getElementById('fb');
  var sendBtn=document.getElementById('send');
  stars.forEach(function(s){
    s.addEventListener('click',function(){
      rating=Number(s.dataset.n);
      stars.forEach(function(x){x.classList.toggle('on',Number(x.dataset.n)<=rating);});
      fb.style.display='block';sendBtn.style.display='inline-block';
    });
  });
  sendBtn.addEventListener('click',function(){
    sendBtn.disabled=true;
    fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rating:rating,feedback:fb.value})})
      .then(function(r){return r.json();})
      .then(function(d){
        if(d&&d.redirect){location.href=d.redirect;return;}
        document.getElementById('stars').style.display='none';
        fb.style.display='none';sendBtn.style.display='none';
        document.getElementById('done').style.display='block';
      }).catch(function(){sendBtn.disabled=false;});
  });
</script></body></html>`;
}

exports.publicInfo = async (req, res) => {
  try {
    const rr = await ReviewRequest.findOne({ token: req.params.token });
    if (!rr) return res.status(404).send('<p>Enlace no válido.</p>');
    if (rr.status === 'sent') {
      rr.status = 'clicked';
      rr.clickedAt = new Date();
      await rr.save();
    }
    const Clinic = require('../models/Clinic');
    const clinic = await Clinic.findById(rr.clinic).select('nombreComercial name');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(ratingPage({ clinicName: clinic?.nombreComercial || clinic?.name }));
  } catch (err) {
    res.status(500).send('<p>Error. Inténtalo más tarde.</p>');
  }
};

exports.publicSubmit = async (req, res) => {
  try {
    const rr = await ReviewRequest.findOne({ token: req.params.token });
    if (!rr) return res.status(404).json({ message: 'Enlace no válido' });
    const rating = Math.max(1, Math.min(5, Number(req.body.rating) || 0));
    if (!rating) return res.status(400).json({ message: 'Calificación requerida' });
    rr.rating = rating;
    rr.feedback = String(req.body.feedback || '').slice(0, 1000);
    rr.ratedAt = new Date();
    rr.status = 'rated';

    const cfg = await CallCenterConfig.findOne({ clinic: rr.clinic }).lean();
    const rep = cfg?.reputation || {};
    const minRating = rep.minRating || 4;
    let redirect = null;
    if (rating >= minRating && rep.googleReviewUrl) {
      redirect = rep.googleReviewUrl;
      rr.status = 'redirected';
    }
    await rr.save();
    res.json({ ok: true, redirect });
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};
