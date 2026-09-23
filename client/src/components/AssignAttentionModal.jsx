import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import Modal from './Modal';
import AppointmentValueFields from './AppointmentValueFields';
import SearchableSelect from './SearchableSelect';
import ServiceItemPicker from './ServiceItemPicker';
import SelectorComponentesSuero from './SelectorComponentesSuero';
import SueroComposicionEditor from './SueroComposicionEditor';
import { SUERO_CLORURO_NOMBRE } from '../constants/sueroterapia';
import { useAuth } from '../context/AuthContext';
import { doctorOptionLabel, doctorTypeLabel } from '../utils/roles';
import { pendingSerums, serumProgress } from '../utils/serumProgress';
import {
  HiOutlineBeaker,
  HiOutlineHeart,
  HiOutlineTrash,
  HiOutlineArrowUp,
  HiOutlineArrowDown,
  HiOutlineCheck,
} from 'react-icons/hi2';

/** Preparación en blanco: el cloruro va en todos y el volumen lo decide quien la pone. */
const sueroVacio = () => ({ base: { name: SUERO_CLORURO_NOMBRE, volumeMl: null }, components: [] });

/**
 * ASIGNAR LA ATENCIÓN cuando el paciente llega a la clínica.
 *
 * Sustituye al antiguo modal de tres pasos (asistir → cobrar → derivar):
 *  · «asistió» se sobreentiende — quien está delante del mostrador ha venido, y
 *    el servidor pone ese estado solo al asignar;
 *  · el cobro salió de aquí al separar la parte contable de la operativa.
 *
 * Lo que queda es lo único que decide recepción: POR QUIÉN pasa el paciente, y
 * EN QUÉ ORDEN. Cada uno atiende, guarda su seguimiento y la cita pasa sola al
 * siguiente; el último la da por terminada.
 *
 * ENFERMERÍA ES UN PASO MÁS DE LA COLA, no una casilla al final. Antes solo se
 * podía mandar a enfermería DESPUÉS de los doctores, y el caso más común es el
 * contrario: que tome los signos antes de que pase el médico. Puede ir en
 * cualquier posición, y más de una vez (signos antes, aplicación después).
 *
 * CADA PASO DE ENFERMERÍA SE PUEDE NOMBRAR O DEJAR ABIERTO. Abierto sale a la
 * bandeja de todos y lo atiende el primero que lo tome —como siempre—; nombrado
 * es de esa persona y solo le aparece a ella. Los dos hacen falta a la vez: un
 * detox se atiende «primero Ana, y cuando termine, quien esté libre».
 *
 * Y cada paso lleva SU servicio, porque con dos enfermeros en la misma cita el
 * servicio de la cita ya no dice quién hizo qué: sin esto los dos seguimientos
 * salían con el mismo texto y no había forma de distinguir el detox del suero.
 *
 * Props: appointment, doctors, nurses, onClose, onDone
 */
const ENFERMERIA = 'enfermeria';

export default function AssignAttentionModal({
  appointment,
  doctors: doctorsDeLaSedeActiva = [],
  nurses: nursesDeLaSedeActiva = [],
  onClose,
  onDone,
}) {
  const apt = appointment;

  const { hasRole, activeClinic } = useAuth();

  /**
   * EL PERSONAL ES EL DE LA SUCURSAL DE LA CITA, NO EL DE LA MÍA.
   *
   * Caja ve la agenda de toda la organización y agenda para cualquier sede, así
   * que este modal se abre a menudo sobre una cita de OTRA sucursal. Las listas
   * que llegan por props son las de la sucursal activa: asignar con ellas dejaba
   * la cita a nombre de un doctor de otra sede, que no la ve en su agenda —y el
   * servidor ahora lo rechaza (ver assignDoctor). Cuando la cita es de otra sede
   * se pide su personal.
   */
  const sedeDeLaCita = String(apt?.clinic?._id || apt?.clinic || '');
  const esOtraSede = !!sedeDeLaCita && String(activeClinic?._id || '') !== sedeDeLaCita;
  const nombreDeLaSede = apt?.clinic?.nombreComercial || apt?.clinic?.name || '';
  const [personalDeLaSede, setPersonalDeLaSede] = useState(null);
  const [cargandoPersonal, setCargandoPersonal] = useState(false);

  useEffect(() => {
    if (!esOtraSede) {
      setPersonalDeLaSede(null);
      return undefined;
    }
    let vivo = true;
    setCargandoPersonal(true);
    Promise.all([
      api.get('/users/doctors', { params: { clinic: sedeDeLaCita } }),
      api.get('/users/nurses', { params: { clinic: sedeDeLaCita } }),
    ])
      .then(([d, n]) => {
        if (vivo) setPersonalDeLaSede({ doctors: d.data || [], nurses: n.data || [] });
      })
      .catch(() => {
        // Sin lista no se puede asignar a ciegas: se deja vacía y el aviso de
        // arriba explica que es de otra sucursal.
        if (vivo) setPersonalDeLaSede({ doctors: [], nurses: [] });
      })
      .finally(() => {
        if (vivo) setCargandoPersonal(false);
      });
    return () => {
      vivo = false;
    };
  }, [esOtraSede, sedeDeLaCita]);

  const doctors = personalDeLaSede ? personalDeLaSede.doctors : doctorsDeLaSedeActiva;
  const nurses = personalDeLaSede ? personalDeLaSede.nurses : nursesDeLaSedeActiva;

  // Los turnos ya completados no se tocan: ese profesional ya escribió su
  // seguimiento. Los pendientes se cargan para poder reordenarlos sin empezar
  // de cero.
  const completados = useMemo(
    () => (apt?.turns || []).filter((t) => t.status === 'completado'),
    [apt]
  );

  /**
   * LOS DOCTORES QUE YA ESTABAN EN LA COLA al abrir el modal. Es la red de
   * seguridad de la reasignación: guardar la cola REEMPLAZA los turnos
   * pendientes, así que quitar a alguien de la lista y guardar lo saca de la
   * cita — y ha pasado que recepción reabre el modal solo para añadir a
   * enfermería, guarda, y el doctor que estaba quedó fuera sin darse cuenta
   * (la cita se cerraba «solo enfermería» y el doctor desaparecía de la
   * agenda). Si al guardar falta alguien que estaba, se avisa antes.
   */
  const doctoresIniciales = useMemo(() => {
    const turnos = apt?.turns || [];
    const pendientes = turnos
      .filter((t) => t.kind === 'doctor' && t.status === 'pendiente')
      .map((t) => String(t.user?._id || t.user));
    // Si hay turnos, el doctor completado no forma parte de la cola editable:
    // el servidor lo conserva como historial. Incluir aquí el espejo `doctor`
    // hacía que quitar únicamente un turno pendiente de enfermería pareciera
    // también un intento de borrar al médico que ya atendió.
    if (turnos.length) return pendientes;
    // Respaldo para citas antiguas que todavía no tienen `turns`.
    return apt?.doctor ? [String(apt.doctor._id || apt.doctor)] : [];
  }, [apt]);

  // Cola de pasos:
  //   { kind: 'doctor', user }
  //   { kind: 'enfermeria', user: id|'' , serviceName }   ('' = cualquier enfermero)
  // `key` solo para React: enfermería puede repetirse y los ids no bastan.
  const [cola, setCola] = useState(() => {
    const turnos = apt?.turns || [];
    const pendientes = turnos.filter((t) => t.status === 'pendiente');
    if (turnos.length) {
      return pendientes.map((t, i) =>
        t.kind === ENFERMERIA
          ? {
              kind: ENFERMERIA,
              user: t.user ? String(t.user?._id || t.user) : '',
              // UN PASO, VARIOS ENFERMEROS (sep-2026): la lista de nombrados del
              // paso. Los pendientes existentes cargan como filas sueltas.
              users: t.user ? [String(t.user?._id || t.user)] : [],
              serviceName: t.serviceName || '',
              // Lo que mostrador le escribió a la enfermera para este paso
              // (sep-2026): viaja con el paso para poder corregirlo aquí.
              nurseInstructions: t.nurseInstructions || '',
              // HIDROTERAPIA (sep-2026): la marcó mostrador al asignar; vuelve
              // a viajar con el paso para poder quitarla aquí.
              hidroterapia: !!t.hidroterapia?.solicitada,
              // El suero que ya se indicó, y DÓNDE quedó escrito. Los dos viajan
              // de vuelta: sin el segundo, reordenar la cola volvería a
              // escribirlo en la ficha (ver Appointment.turns[].serumFollowUp).
              serum: t.serum?.components?.length
                ? { base: { ...(t.serum.base || {}) }, components: t.serum.components.map((c) => ({ ...c })) }
                : null,
              serumFollowUp: t.serumFollowUp || null,
              serumMergeIntoService: !!t.serumMergeIntoService,
              key: `enf-${i}`,
            }
          : { kind: 'doctor', user: String(t.user?._id || t.user), key: `doc-${t.user?._id || t.user}` }
      );
    }
    return apt?.doctor?._id
      ? [{ kind: 'doctor', user: String(apt.doctor._id), key: `doc-${apt.doctor._id}` }]
      : [];
  });
  /**
   * LA COLA VIENE DE LA CITA (sep-2026). Cuando hay turnos pendientes, este
   * modal los CARGA para reordenarlos — y ha generado confusión: se abre, se
   * añade o corrige un paso, se cierra sin guardar, y de fuera parece que ya
   * estaba asignado. Que quede dicho: lo que se ve aquí es lo que YA está
   * asignado; cambiarlo no hace nada hasta pulsar «Asignar».
   */
  const vinieronDeLaCita = (apt?.turns || []).some((t) => t.status === 'pendiente');
  /**
   * EL SERVICIO DE LA CITA SE CORRIGE AQUÍ, al recibir al paciente.
   *
   * Es el momento en que se sabe a qué viene de verdad: media agenda se llena
   * por teléfono con «viene mañana, ya veremos a qué», y hasta ahora había que
   * salir de este modal, abrir el detalle y entrar a «Cambiar servicio y valor»
   * para escribir una palabra. Va por la misma puerta que la asignación
   * (`assignDoctor` → `resolverServicioAgenda`), no por otra.
   *
   * Y no es cosmético: si el servicio nuevo trae su propio suero, al guardar se
   * escribe solo en los seguimientos, igual que si se hubiera agendado así.
   */
  // Se conserva el objeto ENTERO del servicio (no solo id + nombre): de él sale
  // `autoSerum`, y sin eso esta pantalla no sabe que el servicio ya escribe su
  // propia bolsa y ofrece escoger otra como si no hubiera ninguna.
  const [servicio, setServicio] = useState(
    apt?.serviceItem
      ? (typeof apt.serviceItem === 'object'
          ? { ...apt.serviceItem, name: apt.serviceItem.name || apt.serviceName || '' }
          : { _id: apt.serviceItem, name: apt.serviceName || '' })
      : null
  );
  /**
   * El suero DE SERIE del servicio elegido, si lo trae. Es lo que convierte
   * «escoger un suero» en «añadir ampollas al suero que ya hay»: son la misma
   * bolsa, y escribirlas por separado dejaba dos recetas con el mismo nombre.
   */
  const sueroDelServicio = servicio?.autoSerum?.enabled ? servicio : null;
  const sueroDelServicioTexto = (sueroDelServicio?.autoSerum?.components || [])
    .map((c) => `${c.name}${Number(c.quantity) > 1 ? ` ×${c.quantity}` : ''}`)
    .join(', ');
  /** La bolsa del servicio, lista para editarla en un paso de enfermería. */
  const bolsaDelServicio = () => ({
    base: { ...(sueroDelServicio?.autoSerum?.base || sueroVacio().base) },
    components: (sueroDelServicio?.autoSerum?.components || []).map((c) => ({ ...c })),
  });
  const [busy, setBusy] = useState(false);
  // Índice del paso cuyo catálogo de ampollas está abierto (uno para toda la
  // cola: solo se escoge en uno a la vez).
  const [catalogoDe, setCatalogoDe] = useState(null);
  // Nota de recepción al recibir al paciente. No se queda en la cita: va a la
  // bitácora de Observaciones del paciente, junto a las demás.
  const [observacion, setObservacion] = useState('');
  const contador = useRef(0);
  const [suerosDeFicha, setSuerosDeFicha] = useState([]);

  // Solo se trae el catálogo de sueros PENDIENTES de la ficha para ofrecerlo al
  // asignar enfermería. Los que ya llegaron a su cantidad recetada no deben
  // volver a proponerse para otra cita.
  //
  // `conReceta=1`: la receta de una consulta del TERAPEUTA es privada —el
  // seguimiento llega como tocón—, pero lo que se le recetó sí se puede ver
  // desde la agenda (sep-2026). Sin esto, el suero que recetó el terapeuta no
  // salía en esta lista y quien asignaba a enfermería no tenía nada que
  // escojer: la cita llegaba al enfermero sin suero dentro.
  useEffect(() => {
    const patientId = apt?.patient?._id || apt?.patient;
    if (!patientId) return undefined;
    let vivo = true;
    api.get(`/clinical-records/${patientId}`, { params: { conReceta: 'true' } })
      .then(({ data }) => {
        const sueros = (data?.followUps || []).filter((fu) =>
          pendingSerums(fu).length > 0
        );
        if (vivo) setSuerosDeFicha(sueros);
      })
      .catch(() => { if (vivo) setSuerosDeFicha([]); });
    return () => { vivo = false; };
  }, [apt?.patient?._id, apt?.patient]);

  const nombreDelSuero = (fu) => {
    const lineas = pendingSerums(fu).map((linea) => {
      const base = linea?.serumBase?.name
        ? `${linea.serumBase.name}${linea.serumBase.volumeMl ? ` ${linea.serumBase.volumeMl} ml` : ''}`
        : '';
      const componentes = (linea?.serumComponents || [])
        .map((c) => `${c.name || c.code || 'Componente'} ×${c.quantity || 1}`)
        .join(', ');
      const { applied, prescribed, remaining } = serumProgress(linea);
      const faltante = `${remaining === 1 ? 'falta' : 'faltan'} ${remaining}`;
      const aplicado = applied === 1 ? 'aplicado' : 'aplicados';

      return [
        linea?.name || linea?.productName || 'Suero',
        base,
        componentes ? `[${componentes}]` : '',
        `${applied} de ${prescribed} ${aplicado}`,
        faltante,
      ]
        .filter(Boolean)
        .join(' · ');
    });

    return [
      fu?.fecha ? String(fu.fecha).slice(0, 10) : '',
      lineas.join(' / '),
    ]
      .filter(Boolean)
      .join(' · ');
  };

  /** Composición pendiente del suero de la ficha, lista para el editor. */
  const composicionDeFicha = (fu) => {
    const linea = pendingSerums(fu)[0];
    if (!linea) return null;
    return {
      base: {
        name: linea.serumBase?.name || SUERO_CLORURO_NOMBRE,
        volumeMl: linea.serumBase?.volumeMl ?? null,
      },
      components: (linea.serumComponents || []).map((c) => ({ ...c })),
    };
  };

  /** Descripción corta del suero pendiente (sin la fecha, que va aparte). */
  const textoDelSueroDeFicha = (fu) =>
    nombreDelSuero(fu).split(' · ').slice(1).join(' · ');

  /**
   * ESCOGER UN SUERO QUE YA ESTÁ EN LA FICHA.
   *
   * La composición se PRECARGA en el editor: el usuario ve TODAS las
   * ampollas/moléculas que ese suero lleva —igual que al crearlo desde cero—
   * y puede añadir o quitar alguna antes de guardar. `serumTocado` queda
   * apagado: si se guarda sin tocar nada, la receta se respeta tal cual está
   * escrita; en cuanto se corrige algo, el editor enciende la marca y el
   * servidor REESCRIBE aquella receta (no abre otra).
   */
  const escogerSueroDeFicha = (idx, fu) => {
    editarPaso(idx, {
      serumFollowUp: String(fu._id),
      serum: composicionDeFicha(fu) || sueroVacio(),
      serumTocado: false,
      serumMergeIntoService: false,
    });
  };

  /**
   * QUITAR EL SUERO DEL PASO, también de la ficha.
   *
   * Se limpia `serumFollowUp` a propósito: es lo que le dice al servidor que
   * aquella receta se quedó sin dueño y que la quite (la del SERVICIO no se
   * toca, la protege el propio servidor). Dejarla puesta era precisamente lo
   * que impedía quitar un suero ya escrito: el limpiador lo seguía contando
   * como vivo y la receta quedaba huérfana para siempre.
   */
  const quitarSueroDelPaso = (idx) =>
    editarPaso(idx, {
      serum: null,
      serumFollowUp: null,
      serumTocado: false,
      serumMergeIntoService: false,
    });

  /**
   * El VALOR de la cita lo pone mostrador, en el momento en que recibe al
   * paciente. Al resto (doctores, enfermería) ni se le enseña el campo, y el
   * servidor tampoco se lo aceptaría: es lo que se le va a cobrar, no una
   * decisión de quien atiende.
   */
  const puedeFijarValor = hasRole('admin', 'cajero');
  // Se precargan con lo que ya tenga la cita: reabrir el modal para añadir un
  // doctor no puede borrar el importe que ya se había anotado.
  const [valor, setValor] = useState(
    apt?.agreedValue === null || apt?.agreedValue === undefined ? '' : String(apt.agreedValue)
  );
  const [canje, setCanje] = useState(!!apt?.isCanje);
  // Lo que ya pagó por teléfono. Se precarga igual que el importe: recepción
  // llega a esta pantalla para CONFIRMARLO, no para volver a preguntarlo.
  const [adelanto, setAdelanto] = useState(apt?.advancePayment || '');
  const [abonado, setAbonado] = useState(
    apt?.advanceAmount ? String(apt.advanceAmount) : ''
  );
  // Con qué pagó ese adelanto (efectivo, transferencia, tarjeta).
  const [formaPago, setFormaPago] = useState(apt?.advanceMethod || '');

  const porId = useMemo(() => new Map(doctors.map((d) => [String(d._id), d])), [doctors]);
  const enfermeroPorId = useMemo(() => new Map(nurses.map((n) => [String(n._id), n])), [nurses]);
  const yaEnCola = cola.filter((p) => p.kind === 'doctor').map((p) => p.user);
  const disponibles = doctors.filter((d) => !yaEnCola.includes(String(d._id)));

  const agregarDoctor = (id) => {
    if (!id || yaEnCola.includes(id)) return;
    setCola((c) => [...c, { kind: 'doctor', user: id, key: `doc-${id}` }]);
  };
  const agregarEnfermeria = () =>
    setCola((c) => [
      ...c,
      // Nace ABIERTO (sin nombrar): "cualquier enfermero" sigue siendo el
      // valor por defecto. En el paso se pueden escoger a VARIOS.
      { kind: ENFERMERIA, user: '', users: [], serviceName: '', nurseInstructions: '', hidroterapia: false, key: `enf-${(contador.current += 1)}` },
    ]);
  const editarPaso = (idx, patch) =>
    setCola((c) => c.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  const quitar = (idx) => setCola((c) => c.filter((_, i) => i !== idx));
  const mover = (idx, delta) => {
    setCola((c) => {
      const destino = idx + delta;
      if (destino < 0 || destino >= c.length) return c;
      const copia = [...c];
      [copia[idx], copia[destino]] = [copia[destino], copia[idx]];
      return copia;
    });
  };

  const guardar = async () => {
    /**
     * LA COLA VACÍA VALE. Antes se exigía «al menos un doctor o un paso de
     * enfermería», y eso convertía dos cosas normales en imposibles: corregir un
     * no-show («sí vino») obligaba a inventarse un profesional, y al doctor
     * puesto por error no había forma de quitarlo, porque guardar sin nadie
     * estaba prohibido. Se avisa, porque la cita se queda sin dueño, pero se
     * deja hacer.
     */
    if (!cola.length && !confirm('Vas a dejar la cita sin nadie asignado. ¿Continuar?')) return;
    /**
     * Y si al guardar FALTA un doctor que ya estaba en la cola, se pregunta
     * antes: reabrir el modal para añadir a enfermería no puede llevarse por
     * delante al doctor que ya estaba anotado. La intención de quitarlo existe
     * y se respeta —confirmar es el gesto—, pero ya no pasa de manera silenciosa.
     */
    const quitados = doctoresIniciales.filter(
      (id) => !cola.some((p) => p.kind === 'doctor' && p.user === id)
    );
    if (quitados.length) {
      const nombres = quitados
        .map((id) => porId.get(id)?.name || 'un doctor')
        .join(', ');
      if (!confirm(`Vas a quitar de la cita a ${nombres}. El doctor dejará de aparecer en la agenda de esta cita. ¿Continuar?`)) {
        return;
      }
    }
    setBusy(true);
    try {
      const { data } = await api.post(`/appointments/${apt._id}/assign-doctor`, {
        steps: cola.map((p) =>
          p.kind === ENFERMERIA
            ? {
                kind: ENFERMERIA,
                user: p.user || (p.users || [])[0] || null,
                // UN PASO, VARIOS ENFERMEROS (sep-2026): la lista completa de
                // nombrados del paso.
                users: (p.users || []).length ? p.users : (p.user ? [p.user] : []),
                serviceName: (p.serviceName || '').trim(),
                // Sin ampollas no se manda nada: una bolsa vacía no es un suero.
                serum: p.serum?.components?.some((c) => c.name?.trim()) ? p.serum : null,
                /**
                 * DÓNDE está escrito ese suero — SIEMPRE, aunque se haya
                 * corregido. Antes, al tocarlo, esto se mandaba en null para que
                 * el servidor lo escribiera «de nuevo»… y lo que hacía era abrir
                 * una SEGUNDA bolsa dejando la equivocada en la ficha, que se lee
                 * como que al paciente le recetaron dos sueros.
                 *
                 * Ahora viaja la referencia y, con `serumTocado`, el servidor
                 * reescribe AQUELLA receta. Sin suero también viaja: es como sabe
                 * cuál tiene que borrar de la ficha.
                 */
                serumFollowUp: p.serumFollowUp || null,
                serumTocado: !!p.serumTocado,
                // Lo escogido aquí se SUMA a la bolsa que ya escribió el servicio
                // (no abre una segunda receta con el mismo nombre).
                serumMergeIntoService: !!p.serumMergeIntoService,
                // Indicaciones para la enfermera de este paso: le aparecen en su
                // barra de atención, junto al suero que va a aplicar.
                nurseInstructions: (p.nurseInstructions || '').trim(),
                // HIDROTERAPIA (sep-2026): la marca mostrador; la enfermera la
                // ve en su barra y da fe de si la realizó.
                hidroterapia: !!p.hidroterapia,
              }
            : { kind: 'doctor', user: p.user }
        ),
        // El servicio de la cita, tal como quede aquí (vacío = quitarlo).
        serviceItem: servicio?._id || null,
        observation: observacion.trim(),
        // Solo se mandan si este rol puede fijarlos: así una asignación hecha por
        // enfermería no viaja con los campos vacíos y borra el valor que caja ya
        // había anotado.
        ...(puedeFijarValor
          ? {
              agreedValue: canje ? 0 : valor === '' ? null : Number(valor),
              isCanje: canje,
              advancePayment: adelanto || '',
              advanceAmount: abonado === '' ? 0 : Number(abonado),
              advanceMethod: formaPago || '',
            }
          : {}),
      });
      const nombres = cola.map((p) =>
        p.kind === ENFERMERIA
          ? p.user
            ? enfermeroPorId.get(p.user)?.name || 'Enfermería'
            : 'Enfermería'
          : porId.get(p.user)?.name || 'Doctor'
      );
      toast.success(
        !nombres.length
          ? 'Cita guardada sin nadie asignado'
          : nombres.length > 1
            ? `Paciente asignado: ${nombres.join(' → ')}`
            : `Paciente asignado a ${nombres[0]}`
      );
      /**
       * Se dice que el suero YA QUEDÓ ESCRITO en la ficha. Sin esto, mostrador
       * no tiene forma de saber que enfermería ya lo tiene y acaba escribiéndolo
       * a mano en el seguimiento — que es justo el trabajo que esto viene a
       * quitar, y de paso quedaría duplicado.
       */
      // Lo que NO se pudo tocar porque el paciente ya lo tenía puesto. Va aparte
      // y dura más: es lo único que el usuario tiene que leer entero.
      (data?.autoSerum?.avisos || []).forEach((a) => toast(a, { duration: 9000, icon: '⚠️' }));
      if (data?.autoSerum?.items?.length) {
        toast.success(
          `Suero anotado en los seguimientos: ${data.autoSerum.items.join(', ')}`,
          { icon: '💧', duration: 5000 }
        );
      }
      onDone?.(data);
      onClose?.();
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo asignar la atención');
    } finally {
      setBusy(false);
    }
  };

  const paciente = apt?.patient ? `${apt.patient.firstName} ${apt.patient.lastName}` : 'Paciente';
  // La cabecera dice el servicio ELEGIDO ahora mismo (el selector de abajo lo
  // cambia en caliente), y cae a los del inventario en las citas antiguas.
  const nombreServicio =
    servicio?.name || (apt?.services || []).map((s) => s.name).filter(Boolean).join(', ');

  /**
   * UN SOLO catálogo para toda la cola, y no uno por paso: son 104 ampollas a
   * pantalla completa y solo se escoge en un paso a la vez. Montar uno por fila
   * multiplicaría el trabajo del render por nada.
   */
  const catalogo = catalogoDe !== null && (
    <SelectorComponentesSuero
      isOpen
      seleccionados={cola[catalogoDe]?.serum?.components || []}
      onClose={() => setCatalogoDe(null)}
      onConfirm={(components) => {
        editarPaso(catalogoDe, {
          serum: { ...(cola[catalogoDe]?.serum || sueroVacio()), components },
          serumTocado: true,
        });
        setCatalogoDe(null);
      }}
    />
  );

  return (
    <Modal isOpen onClose={onClose} title="Asignar atención" size="lg">
      {catalogo}
      <div className="space-y-4">
        <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3">
          <p className="font-semibold text-slate-800">{paciente}</p>
          <p className="text-sm text-slate-500">
            {apt?.startTime}{nombreServicio ? ` · ${nombreServicio}` : ''}
          </p>
        </div>

        {/* La cita es de otra sucursal: se dice, porque el personal que sale en
            los selectores es el de ESA sede y no el de la propia. */}
        {esOtraSede && (
          <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            {cargandoPersonal
              ? `Cargando el personal de ${nombreDeLaSede || 'la sucursal de la cita'}…`
              : `Esta cita es de ${nombreDeLaSede || 'otra sucursal'}: aquí solo aparece el personal de esa sede.`}
          </div>
        )}

        {completados.length > 0 && (
          <div className="text-xs text-slate-500 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">
            Ya atendieron:{' '}
            {completados
              .map((t) => t.user?.name || (t.kind === 'enfermeria' ? 'Enfermería' : 'Profesional'))
              .join(', ')}
            . No se pueden quitar: su seguimiento ya está escrito.
          </div>
        )}

        {/**
          * LA CITA QUEDÓ ESPERANDO EL SUERO (sep-2026): el doctor terminó y el
          * turno vigente es de enfermería con el suero sin decidir. Este guardado
          * es lo que la libera: escoge el suero del paso (o deja el paso sin
          * ninguno, si no se lo pondrán) y al guardar sale a la bandeja.
          */}
        {apt?.serumStatus && (
          <div className="text-xs text-amber-900 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2">
            {apt.serumStatus === 'aplazado'
              ? 'Esta cita quedó con SUERO PENDIENTE: el paciente decidió no aplicárselo en esa visita. Al guardar con el suero que corresponda la liberas para enfermería; guardando sin suero sigue pendiente — salvo que el paso lleve solo hidroterapia o solo indicaciones: entonces sale a la bandeja igual.'
              : 'Esta cita está esperando que asignes el SUERO de enfermería: lo que recetó el doctor no siempre es lo que toca aplicar ahora. Escoge el suero en su paso de enfermería y guarda para liberar la cita. Si no le van a poner suero —solo hidroterapia o solo indicaciones—, guarda tal cual y la cita sale a la bandeja.'}
          </div>
        )}

        {/* A QUÉ VIENE. Se corrige aquí porque es aquí donde se sabe: la cita se
            cerró por teléfono con un «ya veremos» y el paciente está delante. */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            Servicio de la cita
          </label>
          <ServiceItemPicker value={servicio} onChange={setServicio} />
          <p className="text-[11px] text-slate-400 mt-1">
            Pincha para ver la lista. Si no está, escríbelo y se crea para todos. Si el servicio
            trae su propio suero, se escribe solo en los seguimientos al guardar.
          </p>
        </div>

        {/* Cola de atención: doctores y enfermería, mezclados y en orden */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            Por quién pasa, en orden
          </label>

          {cola.length === 0 && (
            <p className="text-xs text-slate-400 italic mb-2">
              Todavía no has añadido a nadie. Usa los botones de abajo — o guarda así, y la cita
              queda recibida a la espera de que se decida quién la ve.
            </p>
          )}

          {vinieronDeLaCita && cola.length > 0 && (
            <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5 mb-2">
              Esta cola <b>ya estaba asignada</b> en la cita: lo que ve aquí es lo que hay ahora.
              Añadir, quitar o reordenar no cambia nada hasta pulsar <b>Asignar</b>.
            </p>
          )}

          <ul className="space-y-1.5 mb-2">
            {cola.map((paso, idx) => {
              const esEnf = paso.kind === ENFERMERIA;
              const d = esEnf ? null : porId.get(paso.user);
              return (
                <li
                  key={paso.key}
                  className={`rounded-lg px-3 py-2 border ${
                    esEnf ? 'bg-sky-50 border-sky-200' : 'bg-white border-slate-200'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`w-6 h-6 shrink-0 rounded-full text-white text-xs font-bold flex items-center justify-center ${
                        esEnf ? 'bg-sky-600' : 'bg-emerald-600'
                      }`}
                    >
                      {idx + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={`flex items-center gap-1.5 text-sm truncate ${esEnf ? 'text-sky-800 font-medium' : 'text-slate-700'}`}>
                        {esEnf && <HiOutlineHeart className="w-4 h-4 shrink-0" />}
                        {esEnf
                          ? paso.user
                            ? enfermeroPorId.get(paso.user)?.name || 'Enfermería'
                            : 'Enfermería'
                          : d?.name || 'Doctor'}
                      </span>
                      <span className={`block text-[11px] ${esEnf ? 'text-sky-700/80' : 'text-slate-400'}`}>
                        {esEnf
                          ? paso.user
                            ? 'Solo le aparece a esta persona'
                            : 'La atiende el primer enfermero que la tome'
                          : doctorTypeLabel(d)}
                      </span>
                    </span>
                    <button type="button" title="Subir" onClick={() => mover(idx, -1)} disabled={idx === 0}
                      className="p-1 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer disabled:opacity-30">
                      <HiOutlineArrowUp className="w-4 h-4" />
                    </button>
                    <button type="button" title="Bajar" onClick={() => mover(idx, 1)} disabled={idx === cola.length - 1}
                      className="p-1 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer disabled:opacity-30">
                      <HiOutlineArrowDown className="w-4 h-4" />
                    </button>
                    <button type="button" title="Quitar" onClick={() => quitar(idx)}
                      className="p-1 text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer">
                      <HiOutlineTrash className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Quién y qué, solo en los pasos de enfermería: al doctor se
                      le nombra siempre y su servicio es el de la cita. */}
                  {esEnf && (
                    <div className="mt-2 pl-8 flex flex-col gap-2">
                      {/**
                        * EL PASO DE ENFERMERÍA ES COMPARTIDO (sep-2026): en este
                        * UNICO paso se escogen a TODOS los enfermeros que van a
                        * atender al paciente. Sin nombrar = "cualquier
                        * enfermero" (lo toma el primero); con dos o más, todos
                        * la ven cuando le toca a enfermería y cada uno cierra
                        * su parte — y cualquiera puede terminar la atención.
                        */}
                      {(paso.users || []).length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {paso.users.map((uid) => (
                            <span
                              key={uid}
                              className="inline-flex items-center gap-1.5 pl-2.5 pr-1 py-1 rounded-full bg-sky-100 text-sky-800 text-xs font-medium"
                            >
                              {enfermeroPorId.get(uid)?.name || 'Enfermería'}
                              <button
                                type="button"
                                onClick={() => {
                                  const restantes = paso.users.filter((x) => String(x) !== String(uid));
                                  editarPaso(idx, { users: restantes, user: restantes[0] || '' });
                                }}
                                title="Quitar de este paso"
                                className="p-0.5 rounded-full hover:bg-sky-200 text-sky-700 bg-transparent border-none cursor-pointer leading-none"
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="flex flex-col sm:flex-row gap-2">
                        <div className="flex-1 min-w-0">
                          <SearchableSelect
                            options={nurses.filter(
                              (n) => !(paso.users || []).some((u) => String(u) === String(n._id))
                            )}
                            value=""
                            onChange={(v) => {
                              if (!v) return;
                              const usuarios = [...(paso.users || []), v];
                              editarPaso(idx, { users: usuarios, user: usuarios[0] });
                            }}
                            getLabel={(n) => n.name || ''}
                            placeholder={(paso.users || []).length ? '+ Añadir otro enfermero…' : 'Cualquier enfermero (o escoge quien atiende)'}
                            searchPlaceholder="Buscar enfermero…"
                            size="sm"
                          />
                        </div>
                        <label
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-cyan-200 bg-cyan-50 text-xs font-medium text-cyan-900 cursor-pointer shrink-0 self-start sm:self-center"
                          title="Los enfermeros verán Hidroterapia en su barra de atención y marcarán si la realizó"
                        >
                          <input
                            type="checkbox"
                            checked={!!paso.hidroterapia}
                            onChange={(e) => editarPaso(idx, { hidroterapia: e.target.checked })}
                            className="w-4 h-4 accent-cyan-600 cursor-pointer"
                          />
                          Hidroterapia
                        </label>
                      </div>
                      <span className="block text-[11px] text-sky-700/80">
                        {(paso.users || []).length > 0
                          ? `Atienden juntos: ${(paso.users || []).length} enfermero(s) — cada uno cierra su parte, y cualquiera puede cerrar la atención`
                          : 'La atiende el primer enfermero que la tome'}
                      </span>
                    </div>
                  )}

                  {/**
                    * EL SUERO, ESCOGIDO DEL CATÁLOGO.
                    *
                    * Escribir «suero ala 20 ml» a mano en un rótulo no le deja a
                    * enfermería nada que aplicar, porque lo que se aplica es una
                    * línea de receta en la ficha, con su «Administrar» y su
                    * descuento de inventario. Aquí se escogen las ampollas igual
                    * que en la receta del médico, y al guardar se escriben en los
                    * seguimientos.
                    */}
                  {esEnf && (
                    <div className="mt-2 pl-8 space-y-2">
                      {/**
                       * ESCOGEDOR DE SUERO DE LA FICHA, rediseñado (sep-2026).
                       *
                       * Era un <select> nativo cuyo texto de opciones
                       * («Suero · Cloruro 250 ml · [AMP ×1, ...] · 0 de 1
                       * aplicado · falta 1») se cortaba y se veía inviable, y
                       * sin responsive en móvil. Ahora son TARJETAS: cada una
                       * dice la fecha, el nombre, la composición y el progreso,
                       * con scroll vertical y rompimiento de línea reales.
                       */}
                      {suerosDeFicha.length > 0 && (
                        <div className="rounded-xl border border-violet-200 bg-violet-50/60 p-2.5">
                          <div className="flex items-start justify-between gap-2 mb-1.5">
                            <span className="text-[11px] font-semibold text-violet-900">
                              Suero de la ficha que se aplicará en esta cita
                            </span>
                            {paso.serumFollowUp && (
                              <button
                                type="button"
                                onClick={() => quitarSueroDelPaso(idx)}
                                className="text-[10px] text-violet-700 hover:text-violet-900 underline bg-transparent border-none cursor-pointer shrink-0"
                              >
                                Ninguno (dejar vacío)
                              </button>
                            )}
                          </div>
                          <div className="grid gap-1.5 max-h-60 overflow-y-auto pr-1">
                            {suerosDeFicha.map((fu) => {
                              const elegido = paso.serumFollowUp === String(fu._id);
                              const fecha = fu?.fecha
                                ? new Date(fu.fecha).toLocaleDateString('es-EC')
                                : '';
                              return (
                                <button
                                  key={fu._id}
                                  type="button"
                                  onClick={() => escogerSueroDeFicha(idx, fu)}
                                  className={`text-left w-full rounded-lg border px-2.5 py-2 cursor-pointer transition-colors ${
                                    elegido
                                      ? 'border-violet-500 bg-white ring-2 ring-violet-300'
                                      : 'border-violet-200 bg-white hover:border-violet-400'
                                  }`}
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-[11px] font-semibold text-violet-900 min-w-0 truncate">
                                      {fecha ? `${fecha} · ` : ''}
                                      {(pendingSerums(fu)[0]?.name) || 'Suero'}
                                    </span>
                                    {elegido && (
                                      <HiOutlineCheck className="w-4 h-4 text-violet-600 shrink-0" />
                                    )}
                                  </div>
                                  <div className="text-[10px] text-violet-800/80 mt-0.5 break-words">
                                    {textoDelSueroDeFicha(fu)}
                                  </div>
                                </button>
                              );
                            })}
                            <button
                              type="button"
                              onClick={() =>
                                editarPaso(idx, {
                                  serumFollowUp: null,
                                  serum: sueroVacio(),
                                  serumTocado: true,
                                  serumMergeIntoService: !!sueroDelServicio,
                                })
                              }
                              className="text-left w-full rounded-lg border border-dashed border-violet-300 bg-transparent px-2.5 py-2 text-[11px] font-medium text-violet-800 hover:bg-white cursor-pointer"
                            >
                              + Crear un suero nuevo desde cero
                            </button>
                          </div>
                          <p className="m-0 mt-1.5 text-[10px] text-violet-700">
                            El enfermero verá únicamente el seguimiento escogido al abrir la cita.
                          </p>
                        </div>
                      )}

                      {/* OJO con la condición: basta con que `paso.serum` exista.
                          Al crear el suero desde cero nace con la composición
                          VACÍA — exigirle componentes aquí volvía a caer en el
                          botón «Escoger el suero…» y el editor NUNCA abría:
                          el sistema bloqueaba crear sueros desde la agenda
                          (sep-2026, regresión del rediseño). */}
                      {paso.serum ? (
                        <>
                          {paso.serumMergeIntoService && (
                            <p className="m-0 mb-1 text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-2 py-1.5">
                              Estás editando el suero de <b>«{sueroDelServicio?.name || servicio?.name}»</b>,
                              el que ya está escrito en la ficha. Se guarda como <b>una sola receta</b>.
                            </p>
                          )}
                          {/* Corrigiendo uno que YA está en la ficha: conviene
                              decirlo, porque lo que se guarda no es un suero
                              nuevo sino la reescritura de aquella receta. */}
                          {paso.serumFollowUp && paso.serumTocado && !paso.serumMergeIntoService && (
                            <p className="m-0 mb-1 text-[11px] text-sky-900 bg-sky-50 border border-sky-200 rounded-lg px-2 py-1.5">
                              Estás corrigiendo el suero que <b>ya está escrito en la ficha</b>: se
                              reescribe esa misma receta, no se crea otra.
                            </p>
                          )}
                          {paso.serumFollowUp && !paso.serumTocado && (
                            <p className="m-0 mb-1 text-[11px] text-violet-800 bg-violet-50 border border-violet-100 rounded-lg px-2 py-1.5">
                              Estas son las ampollas del suero escogido de la ficha. Puedes
                              <b> añadir o quitar</b> las que quieras: al primer cambio se reescribe
                              esa receta. Si guardas sin tocar nada, queda como está.
                            </p>
                          )}
                          <SueroComposicionEditor
                            base={paso.serum.base}
                            componentes={paso.serum.components}
                            onChangeBase={(base) =>
                              editarPaso(idx, { serum: { ...paso.serum, base }, serumTocado: true })
                            }
                            onChangeComponentes={(components) =>
                              editarPaso(idx, { serum: { ...paso.serum, components }, serumTocado: true })
                            }
                            onAbrirCatalogo={() => setCatalogoDe(idx)}
                          />
                          <button
                            type="button"
                            onClick={() => quitarSueroDelPaso(idx)}
                            className="mt-1 text-[11px] text-red-500 bg-transparent border-none cursor-pointer p-0"
                          >
                            Quitar el suero
                          </button>
                        </>
                      ) : paso.serumFollowUp ? (
                        /* Referencia a un suero de la ficha cuya composición
                           no está en el turno (escogido solo por referencia, o
                           ya aplicado). Si sigue pendiente en la ficha, se
                           muestra aquí para verlo y editarlo. */
                        (() => {
                          const fu = suerosDeFicha.find((f) => String(f._id) === String(paso.serumFollowUp));
                          if (!fu) {
                            return (
                              <div className="text-[11px] text-emerald-700">
                                <p className="m-0">
                                  <HiOutlineCheck className="inline w-3.5 h-3.5 -mt-px" /> Suero ya escrito
                                  en los seguimientos.
                                </p>
                                <button
                                  type="button"
                                  onClick={() => quitarSueroDelPaso(idx)}
                                  className="mt-1 text-[11px] text-red-500 bg-transparent border-none cursor-pointer p-0"
                                >
                                  Quitar el suero
                                </button>
                              </div>
                            );
                          }
                          return (
                            <div className="text-[11px] text-emerald-700">
                              <p className="m-0 break-words">
                                <HiOutlineCheck className="inline w-3.5 h-3.5 -mt-px" /> Suero de la ficha
                                ({textoDelSueroDeFicha(fu)}).
                              </p>
                              <button
                                type="button"
                                onClick={() => escogerSueroDeFicha(idx, fu)}
                                className="mt-1 text-[11px] font-medium text-sky-700 bg-transparent border-none cursor-pointer p-0"
                              >
                                Ver sus ampollas (y corregirlas si hace falta)
                              </button>
                            </div>
                          );
                        })()
                      ) : (
                        <>
                          {/* El servicio YA escribe su bolsa: lo que se escoja aquí
                              se le suma, no abre una segunda receta con su mismo
                              nombre (que es como acabaron dos «Detox Plus» con
                              ampollas distintas en la ficha de un paciente). */}
                          {sueroDelServicio && (
                            <p className="m-0 mb-1 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
                              <b>«{sueroDelServicio.name}» ya escribe su suero</b>
                              {sueroDelServicioTexto ? ` (${sueroDelServicioTexto})` : ''}. Lo que
                              añadas aquí se suma a <b>esa misma receta</b>: no se crea una segunda.
                            </p>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              editarPaso(idx, {
                                serum: sueroDelServicio ? bolsaDelServicio() : sueroVacio(),
                                serumTocado: true,
                                serumMergeIntoService: !!sueroDelServicio,
                              });
                              /**
                               * EL CATÁLOGO SE ABRE DE UNA VEZ.
                               *
                               * Antes solo se preparaba la bolsa en el estado y
                               * el editor aparecía debajo: con la bolsa vacía
                               * había versiones donde el clic «no hacía nada»
                               * visible y el usuario lo leía como un botón
                               * roto. Abrir el catálogo de una vez da una
                               * respuesta inmediata, y si lo cancela se queda
                               * el editor con la preparación a la vista.
                               */
                              setCatalogoDe(idx);
                            }}
                            className="inline-flex items-center gap-1.5 text-xs font-medium text-sky-700 bg-transparent border-none cursor-pointer p-0"
                          >
                            <HiOutlineBeaker className="w-4 h-4" />
                            {sueroDelServicio
                              ? `Añadir ampollas al suero de «${sueroDelServicio.name}»`
                              : 'Escoger el suero que se va a aplicar'}
                          </button>
                        </>
                      )}
                    </div>
                  )}

                  {/**
                    * INDICACIONES PARA ENFERMERÍA (sep-2026).
                    *
                    * El suero dice QUÉ se pone; esto dice CÓMO y con qué cuidado:
                    * «primero tomar signos», «aplicar lento, avisar si duele»…
                    * La enfermera lo lee en su barra de atención, junto al suero
                    * que le toca poner en ese momento.
                    */}
                  {esEnf && (
                    <div className="mt-2 pl-8">
                      <label className="block text-[11px] font-medium text-slate-500 mb-1">
                        Indicaciones para enfermería{' '}
                        <span className="font-normal text-slate-400">(opcional)</span>
                      </label>
                      <textarea
                        value={paso.nurseInstructions || ''}
                        onChange={(e) => editarPaso(idx, { nurseInstructions: e.target.value })}
                        rows={2}
                        placeholder="Tomar signos antes de aplicar. Aplicar despacio y avisar si duele…"
                        className="w-full px-3 py-2 border border-sky-200 rounded-lg text-[13px] outline-none focus:ring-2 focus:ring-sky-400 focus:border-sky-400 bg-sky-50/50 resize-none"
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="flex flex-col sm:flex-row gap-2">
            {/* CON BUSCADOR: con treinta doctores en la lista se tardaba más en
                bajar el desplegable que en escribir el apellido. Se queda vacío
                después de elegir —es un «añadir a la cola», no un valor— y por
                eso el `value` va fijo en ''. */}
            <div className="flex-1 min-w-0">
              <SearchableSelect
                options={disponibles}
                value=""
                onChange={(v) => v && agregarDoctor(v)}
                getLabel={doctorOptionLabel}
                getSearchText={(d) => `${d.name || ''} ${d.specialty || ''} ${doctorOptionLabel(d)}`}
                placeholder="+ Añadir doctor…"
                searchPlaceholder="Buscar por nombre o especialidad…"
              />
            </div>
            <button
              type="button"
              onClick={agregarEnfermeria}
              disabled={cola.some((p) => p.kind === ENFERMERIA)}
              title={cola.some((p) => p.kind === ENFERMERIA)
                ? 'Ya hay un paso de enfermería: dentro de él escoge a todos los enfermeros que van a atender'
                : undefined}
              className="flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl border border-sky-200 bg-sky-50 text-sm font-medium text-sky-800 cursor-pointer hover:bg-sky-100 shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <HiOutlineHeart className="w-4 h-4" /> Añadir enfermería
            </button>
          </div>

          {cola.length > 1 && (
            <p className="text-[11px] text-slate-500 mt-1.5">
              La cita pasa sola al siguiente cuando cada uno guarda su seguimiento. Solo le
              aparece a quien le toca.
            </p>
          )}
          {/* DÓNDE ESTÁ EL SUERO. Cuelga del paso de enfermería —es quien lo
              pone— y sin ningún paso de enfermería no hay dónde escogerlo. Sin
              este renglón se buscaba en el modal entero y se acababa
              escribiéndolo a mano en el motivo de la cita. */}
          {!cola.some((p) => p.kind === ENFERMERIA) && (
            <p className="text-[11px] text-sky-800 bg-sky-50 border border-sky-100 rounded-lg px-2 py-1.5 mt-1.5">
              ¿Le van a poner un <b>suero</b>? Pulsa <b>Añadir enfermería</b>: las ampollas se
              escogen ahí, en el paso de quien lo aplica.
            </p>
          )}
        </div>

        {/* Valor de la cita — solo mostrador */}
        {puedeFijarValor && (
          <AppointmentValueFields
            value={valor}
            onValueChange={setValor}
            isCanje={canje}
            onCanjeChange={setCanje}
            advancePayment={adelanto}
            onAdvancePaymentChange={setAdelanto}
            advanceAmount={abonado}
            advanceMethod={formaPago}
            onAdvanceMethodChange={setFormaPago}
            onAdvanceAmountChange={setAbonado}
          />
        )}

        {/* Observación del paciente */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            Observación <span className="font-normal text-slate-400">(opcional)</span>
          </label>
          <textarea
            value={observacion}
            onChange={(e) => setObservacion(e.target.value)}
            rows={2}
            placeholder="Vino con la mamá, pidió factura a nombre de la empresa…"
            className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50 resize-none"
          />
          <p className="text-[11px] text-slate-400 mt-1">
            Se guarda en <b>Observaciones</b> del paciente, no en la cita.
          </p>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-600 cursor-pointer"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={guardar}
            disabled={busy}
            className="flex items-center gap-1.5 px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium border-none cursor-pointer disabled:opacity-50"
          >
            {busy
              ? 'Guardando…'
              : <><HiOutlineCheck className="w-4 h-4" /> {cola.length ? 'Asignar' : 'Guardar sin asignar'}</>}
          </button>
        </div>
      </div>
    </Modal>
  );
}

