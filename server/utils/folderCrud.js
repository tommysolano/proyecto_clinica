/**
 * CRUD de CARPETAS anidadas (tipo Windows) reutilizable por varias secciones
 * (mensajes guardados, automatizaciones…). Una carpeta es una RUTA con '/' como
 * separador ("CITA/Recordatorios"); el registro persiste la carpeta aunque esté
 * VACÍA, para poder crear subcarpetas antes de meterles contenido.
 *
 * Uso:
 *   const crud = makeFolderCrud({ FolderModel, ItemModel, folderField: 'folder' });
 *   router.get('/folders', crud.list);
 *   router.post('/folders', crud.create);
 *   router.delete('/folders', crud.remove); // ?path=CITA/Recordatorios
 */

/** Normaliza "  A / B / " → "A/B" (sin barras dobles, espacios ni segmentos vacíos). */
function normFolderPath(raw) {
  return String(raw || '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('/');
}

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function makeFolderCrud({ FolderModel, ItemModel, folderField }) {
  const list = async (req, res) => {
    try {
      const folders = await FolderModel.find({ clinic: req.clinicId }).sort({ name: 1 }).lean();
      res.json(folders);
    } catch (e) {
      res.status(500).json({ message: 'Error al listar carpetas', error: e.message });
    }
  };

  // Crea la carpeta y TODOS sus ancestros (idempotente): crear "A/B/C" también
  // deja registradas "A" y "A/B". Devuelve la carpeta hoja creada.
  const create = async (req, res) => {
    try {
      const path = normFolderPath(req.body.name ?? req.body.path);
      if (!path) return res.status(400).json({ message: 'El nombre de la carpeta es requerido' });
      const segs = path.split('/');
      let leaf = null;
      for (let i = 0; i < segs.length; i++) {
        const p = segs.slice(0, i + 1).join('/');
        // eslint-disable-next-line no-await-in-loop
        leaf = await FolderModel.findOneAndUpdate(
          { clinic: req.clinicId, name: p },
          { $setOnInsert: { clinic: req.clinicId, name: p, createdBy: req.user._id } },
          { new: true, upsert: true }
        );
      }
      res.status(201).json(leaf);
    } catch (e) {
      res.status(500).json({ message: 'Error al crear carpeta', error: e.message });
    }
  };

  // Borra una carpeta y sus subcarpetas del registro. Se BLOQUEA si hay contenido
  // dentro (en la carpeta o en cualquier subcarpeta): primero hay que mover o
  // borrar los elementos, para no dejarlos huérfanos en una carpeta inexistente.
  const remove = async (req, res) => {
    try {
      const path = normFolderPath(req.query.path ?? req.body.path);
      if (!path) return res.status(400).json({ message: 'Ruta de carpeta requerida' });
      const under = { $or: [{ [folderField]: path }, { [folderField]: { $regex: `^${escapeRegex(path)}/` } }] };
      const count = await ItemModel.countDocuments({ clinic: req.clinicId, ...under });
      if (count > 0) {
        return res.status(400).json({
          message: `La carpeta no está vacía (${count} elemento(s) dentro). Muévelos o elimínalos primero.`,
        });
      }
      await FolderModel.deleteMany({
        clinic: req.clinicId,
        $or: [{ name: path }, { name: { $regex: `^${escapeRegex(path)}/` } }],
      });
      res.json({ message: 'Carpeta eliminada' });
    } catch (e) {
      res.status(500).json({ message: 'Error al eliminar carpeta', error: e.message });
    }
  };

  return { list, create, remove };
}

module.exports = { makeFolderCrud, normFolderPath, escapeRegex };
