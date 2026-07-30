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
 *   router.put('/folders', crud.rename);   // { path, name }
 *   router.delete('/folders', crud.remove); // ?path=CITA/Recordatorios&mode=empty|move|purge
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

/**
 * @param onItemsDeleted (ids, req) → limpieza propia del módulo cuando se borran
 *   elementos junto con su carpeta (mode=purge). Es el mismo trabajo que hace el
 *   borrado de UN elemento; p. ej. las automatizaciones cancelan sus inscripciones
 *   vivas, que si no se quedarían apuntando a un workflow inexistente.
 */
function makeFolderCrud({ FolderModel, ItemModel, folderField, onItemsDeleted = null }) {
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

  /** Carpeta padre de una ruta: "A/B/C" → "A/B"; "A" → "" (sin carpeta). */
  const parentOf = (path) => path.split('/').slice(0, -1).join('/');

  /**
   * Borra una carpeta y sus subcarpetas del registro. Qué pasa con el CONTENIDO
   * lo decide `mode`, porque borrar elementos es irreversible y el usuario tiene
   * que elegirlo a conciencia:
   *
   *   - 'empty'  (por defecto): si hay contenido NO borra nada y responde 409 con
   *              `code: 'FOLDER_NOT_EMPTY'` y cuántos elementos hay, para que la
   *              pantalla pueda ofrecer las dos opciones de abajo.
   *   - 'move':  borra la carpeta y su contenido pasa a la carpeta de arriba
   *              (la padre; si era de primer nivel, queda sin carpeta).
   *   - 'purge': borra la carpeta Y todo su contenido, subcarpetas incluidas.
   */
  const remove = async (req, res) => {
    try {
      const path = normFolderPath(req.query.path ?? req.body?.path);
      if (!path) return res.status(400).json({ message: 'Ruta de carpeta requerida' });
      const mode = String(req.query.mode ?? req.body?.mode ?? 'empty');
      if (!['empty', 'move', 'purge'].includes(mode)) {
        return res.status(400).json({ message: `Modo de borrado no válido: ${mode}` });
      }

      const under = { $or: [{ [folderField]: path }, { [folderField]: { $regex: `^${escapeRegex(path)}/` } }] };
      const count = await ItemModel.countDocuments({ clinic: req.clinicId, ...under });

      let movedItems = 0;
      let deletedItems = 0;
      if (count > 0) {
        if (mode === 'empty') {
          return res.status(409).json({
            code: 'FOLDER_NOT_EMPTY',
            count,
            message: `La carpeta no está vacía (${count} elemento(s) dentro).`,
          });
        }
        if (mode === 'purge') {
          // Se recogen los ids ANTES de borrar para poder avisar al módulo (no se
          // pueden consultar después).
          const docs = await ItemModel.find({ clinic: req.clinicId, ...under }).select('_id').lean();
          const ids = docs.map((d) => d._id);
          if (ids.length) {
            await ItemModel.deleteMany({ _id: { $in: ids } });
            if (onItemsDeleted) await onItemsDeleted(ids, req);
          }
          deletedItems = ids.length;
        } else {
          const r = await ItemModel.updateMany(
            { clinic: req.clinicId, ...under },
            { $set: { [folderField]: parentOf(path) } }
          );
          movedItems = r.modifiedCount || 0;
        }
      }

      await FolderModel.deleteMany({
        clinic: req.clinicId,
        $or: [{ name: path }, { name: { $regex: `^${escapeRegex(path)}/` } }],
      });
      res.json({ message: 'Carpeta eliminada', movedItems, deletedItems, movedTo: parentOf(path) });
    } catch (e) {
      res.status(500).json({ message: 'Error al eliminar carpeta', error: e.message });
    }
  };

  /**
   * Renombra una carpeta EN SU SITIO: solo cambia el último segmento, así que
   * "A/B" pasa a "A/Nuevo" y no se mueve de sitio. Arrastra consigo las
   * subcarpetas y los elementos (se les reescribe la ruta), que si no quedarían
   * apuntando a una carpeta que ya no existe.
   */
  const rename = async (req, res) => {
    try {
      const from = normFolderPath(req.body?.path ?? req.query.path);
      const rawName = String(req.body?.name ?? '').trim();
      if (!from) return res.status(400).json({ message: 'Ruta de carpeta requerida' });
      if (!rawName) return res.status(400).json({ message: 'El nombre de la carpeta es requerido' });
      // El nombre es UN segmento: para mover una carpeta de sitio están las
      // acciones de mover, no el renombrado.
      if (rawName.includes('/')) {
        return res.status(400).json({ message: 'El nombre no puede contener "/"' });
      }
      const name = normFolderPath(rawName);
      if (!name) return res.status(400).json({ message: 'El nombre de la carpeta es requerido' });

      const parent = parentOf(from);
      const to = parent ? `${parent}/${name}` : name;
      if (to === from) return res.json({ message: 'Sin cambios', from, to, items: 0, folders: 0 });

      // Ya existe una hermana con ese nombre (en el registro o solo como ruta de
      // algún elemento): renombrar fusionaría dos carpetas sin avisar.
      const [regClash, itemClash] = await Promise.all([
        FolderModel.exists({ clinic: req.clinicId, name: to }),
        ItemModel.exists({
          clinic: req.clinicId,
          $or: [{ [folderField]: to }, { [folderField]: { $regex: `^${escapeRegex(to)}/` } }],
        }),
      ]);
      if (regClash || itemClash) {
        return res.status(409).json({ message: `Ya existe una carpeta llamada "${name}" en este nivel.` });
      }

      // Reescritura de rutas: la carpeta, sus descendientes y los elementos. Son
      // decenas de documentos, así que se resuelve con un bulkWrite legible en vez
      // de una actualización con pipeline de agregación.
      const rePath = (old) => to + old.slice(from.length);
      const subFilter = { $or: [{ name: from }, { name: { $regex: `^${escapeRegex(from)}/` } }] };
      const folders = await FolderModel.find({ clinic: req.clinicId, ...subFilter }).select('name').lean();
      if (folders.length) {
        await FolderModel.bulkWrite(
          folders.map((f) => ({
            updateOne: { filter: { _id: f._id }, update: { $set: { name: rePath(f.name) } } },
          }))
        );
      } else {
        // La carpeta existía solo como ruta de los elementos (nunca se registró):
        // se registra con el nombre nuevo para que siga siendo navegable vacía.
        await FolderModel.updateOne(
          { clinic: req.clinicId, name: to },
          { $setOnInsert: { clinic: req.clinicId, name: to, createdBy: req.user._id } },
          { upsert: true }
        );
      }

      const items = await ItemModel.find({
        clinic: req.clinicId,
        $or: [{ [folderField]: from }, { [folderField]: { $regex: `^${escapeRegex(from)}/` } }],
      })
        .select(folderField)
        .lean();
      if (items.length) {
        await ItemModel.bulkWrite(
          items.map((it) => ({
            updateOne: {
              filter: { _id: it._id },
              update: { $set: { [folderField]: rePath(it[folderField]) } },
            },
          }))
        );
      }

      res.json({ message: 'Carpeta renombrada', from, to, folders: folders.length, items: items.length });
    } catch (e) {
      res.status(500).json({ message: 'Error al renombrar carpeta', error: e.message });
    }
  };

  return { list, create, remove, rename };
}

module.exports = { makeFolderCrud, normFolderPath, escapeRegex };
