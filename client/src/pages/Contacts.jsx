import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { HiOutlineUserGroup } from 'react-icons/hi2';
import api from '../api/axios';
import ContactsTab from '../components/contacts/ContactsTab';
import GroupsTab from '../components/contacts/GroupsTab';
import DripsTab from '../components/contacts/DripsTab';
import ImportsTab from '../components/contacts/ImportsTab';

const TABS = [
  { key: 'contacts', label: 'Contactos' },
  { key: 'groups', label: 'Grupos' },
  { key: 'drips', label: 'Envíos por goteo' },
  { key: 'imports', label: 'Importaciones' },
];

/**
 * Contactos del CRM. Un contacto NO es un paciente: es la identidad de
 * mensajería (puede ser solo un número). Ver server/models/Contact.js.
 *
 * La pestaña vive en la URL (?tab=) para poder enlazar directo desde otras
 * pantallas y para que recargar no te devuelva a la primera.
 */
export default function Contacts() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.key === params.get('tab')) ? params.get('tab') : 'contacts';
  const setTab = (key) => setParams(key === 'contacts' ? {} : { tab: key }, { replace: true });

  // Los grupos hacen falta en casi todas las pestañas (filtrar, importar, enviar):
  // se cargan aquí una vez y se comparten.
  const [groups, setGroups] = useState([]);
  const [groupsVersion, setGroupsVersion] = useState(0);
  const reloadGroups = () => setGroupsVersion((v) => v + 1);

  useEffect(() => {
    let alive = true;
    api
      .get('/contacts/groups')
      .then((r) => { if (alive) setGroups(r.data || []); })
      .catch(() => {});
    return () => { alive = false; };
  }, [groupsVersion]);

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
          <HiOutlineUserGroup className="text-emerald-600" /> Contactos
        </h1>
        <p className="text-xs text-slate-500">
          La agenda de mensajería del CRM. Un contacto puede ser solo un número; cuando agenda, se
          enlaza con su ficha de paciente.
        </p>
      </div>

      <div className="flex items-center gap-1 border-b border-slate-200 mb-4">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm border-none bg-transparent cursor-pointer -mb-px border-b-2 ${
              tab === t.key
                ? 'border-b-emerald-600 text-emerald-700 font-semibold'
                : 'border-b-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'contacts' && <ContactsTab groups={groups} onGroupsChanged={reloadGroups} />}
      {tab === 'groups' && <GroupsTab groups={groups} onGroupsChanged={reloadGroups} />}
      {tab === 'drips' && <DripsTab groups={groups} />}
      {tab === 'imports' && <ImportsTab groups={groups} onGroupsChanged={reloadGroups} />}
    </div>
  );
}
