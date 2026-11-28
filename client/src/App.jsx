import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { countLabel, formatDate, formatMoney, getLanguage, setLanguage as saveLanguage, t } from './i18n.js';

const NAV = [
  ['overview', '⌂', 'Обзор'],
  ['expenses', '↗', 'Расходы'],
  ['balances', '⇄', 'Баланс'],
  ['places', '⌖', 'Места'],
  ['analytics', '▥', 'Аналитика'],
  ['settings', '⚙', 'Настройки'],
];
const ICONS = ['✈️', '🏨', '🚕', '🍽️', '☕', '🛍️', '🎟️', '💊', '🎉', '💳', '🏛️', '🚌'];
const CURRENCIES = ['₸', '$', '€', '₽', '₺'];
const MAP_KEY = import.meta.env.VITE_MAPGL_KEY || '';

async function api(path, options = {}) {
  const auth = JSON.parse(localStorage.getItem('ss_auth') || 'null');
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (auth?.token) headers.Authorization = `Bearer ${auth.token}`;
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(t(data.error || 'server_error'));
    error.status = response.status;
    throw error;
  }
  return data;
}

function money(value, currency = '₸') {
  return formatMoney(value, currency);
}

function tripFromApi(raw) {
  return {
    ...raw,
    budget: Number(raw.budget || 0),
    expenses: (raw.expenses || []).map((expense) => ({ ...expense, amount: Number(expense.amount || 0) })),
    places: (raw.places || []).map((place) => ({ ...place, cost: Number(place.cost || 0) })),
  };
}

function getBalances(trip) {
  const result = Object.fromEntries((trip?.members || []).map((member) => [member, 0]));
  for (const expense of trip?.expenses || []) {
    const people = expense.participants?.length ? expense.participants : [expense.payer];
    result[expense.payer] = (result[expense.payer] || 0) + Number(expense.amount || 0);
    const share = Number(expense.amount || 0) / people.length;
    people.forEach((member) => { result[member] = (result[member] || 0) - share; });
  }
  return result;
}

function getSettlements(trip) {
  const balances = getBalances(trip);
  const creditors = Object.entries(balances).filter(([, amount]) => amount > 0.01).map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount);
  const debtors = Object.entries(balances).filter(([, amount]) => amount < -0.01).map(([name, amount]) => ({ name, amount: -amount })).sort((a, b) => b.amount - a.amount);
  const result = [];
  let i = 0; let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].amount, creditors[j].amount);
    if (amount > 0.01) result.push({ from: debtors[i].name, to: creditors[j].name, amount: Math.round(amount * 100) / 100 });
    debtors[i].amount -= amount;
    creditors[j].amount -= amount;
    if (debtors[i].amount < 0.01) i += 1;
    if (creditors[j].amount < 0.01) j += 1;
  }
  return result;
}

function Card({ children, className = '' }) {
  return <section className={`card ${className}`}>{children}</section>;
}

function Stat({ label, value, hint, icon }) {
  return <Card className="stat-card"><div className="stat-top"><span>{label}</span><span className="stat-icon">{icon}</span></div><strong>{value}</strong>{hint && <small>{hint}</small>}</Card>;
}

function Modal({ title, onClose, children, wide = false }) {
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true"><div className="modal-heading"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label={t('Закрыть')}>×</button></div>{children}</section></div>;
}

function LanguageSwitcher({ value, onChange }) {
  return <label className="language-switcher"><span className="sr-only">{t("Язык интерфейса")}</span><select aria-label={t('Язык интерфейса')} value={value} onChange={(event) => onChange(event.target.value)}><option value="ru">{t('language.ru')}</option><option value="kk">{t('language.kk')}</option><option value="en">{t('language.en')}</option></select></label>;
}

function GoogleLogin({ clientId, onCredential, language }) {
  const buttonRef = useRef(null);
  const [error, setError] = useState('');
  useEffect(() => { setError(''); }, [language]);
  useEffect(() => {
    if (!clientId || !buttonRef.current) return undefined;
    let cancelled = false;
    const render = () => {
      if (cancelled || !window.google?.accounts?.id || !buttonRef.current) return;
      window.google.accounts.id.initialize({ client_id: clientId, callback: async (response) => {
        setError('');
        try { await onCredential(response.credential); } catch (reason) { setError(reason.message || t("Не удалось войти через Google.")); }
      } });
      window.google.accounts.id.renderButton(buttonRef.current, { theme: 'filled_black', size: 'large', shape: 'pill', width: 280, text: 'signin_with', locale: language });
    };
    const script = document.querySelector('script[src="https://accounts.google.com/gsi/client"]');
    if (window.google?.accounts?.id) render();
    else script?.addEventListener('load', render, { once: true });
    return () => { cancelled = true; script?.removeEventListener('load', render); };
  }, [clientId, onCredential, language]);

  return <div className="login-provider"><div ref={buttonRef} />{!clientId && <p className="inline-error">{t("Сервер не передал Google Client ID. Проверьте GOOGLE_CLIENT_ID в .env.")}</p>}{error && <p className="inline-error">{t(error)}</p>}</div>;
}

function MapCanvas({ active, places, picking, onPick }) {
  const containerRef = useRef(null);
  const pickingRef = useRef(picking);
  const pickCallbackRef = useRef(onPick);
  const [mapError, setMapError] = useState('');
  useEffect(() => { pickingRef.current = picking; }, [picking]);
  useEffect(() => { pickCallbackRef.current = onPick; }, [onPick]);

  useEffect(() => {
    if (!active || !containerRef.current) return undefined;
    let cancelled = false;
    let map;
    let markers = [];
    const makeMap = () => {
      if (cancelled || !window.mapgl || !containerRef.current) return;
      if (!MAP_KEY) {
        setMapError('Укажите VITE_MAPGL_KEY в .env, чтобы открыть карту.');
        return;
      }
      try {
        map = new window.mapgl.Map('saparsplit-map', { center: [76.8897, 43.2389], zoom: 11, key: MAP_KEY });
        map.on('click', (event) => {
          if (pickingRef.current && event?.lngLat) pickCallbackRef.current({ lng: event.lngLat[0], lat: event.lngLat[1] });
        });
        markers = places.filter((place) => Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lng))).map((place) => new window.mapgl.Marker(map, { coordinates: [Number(place.lng), Number(place.lat)] }));
        setMapError('');
      } catch {
        setMapError('Не удалось открыть карту. Проверьте доступ к 2GIS MapGL.');
      }
    };
    const script = document.querySelector('script[src="https://mapgl.2gis.com/api/js/v1"]');
    if (window.mapgl) makeMap();
    else script?.addEventListener('load', makeMap, { once: true });
    const timeout = window.setTimeout(() => { if (!window.mapgl) setMapError('Карта недоступна. Проверьте интернет-соединение.'); }, 8000);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      script?.removeEventListener('load', makeMap);
      markers.forEach((marker) => marker.destroy?.());
      map?.destroy?.();
    };
  }, [active, places]);

  return <div className="map-frame"><div className="map-canvas" id="saparsplit-map" ref={containerRef} />{mapError && <div className="map-message">⌖<span>{t(mapError)}</span></div>}{picking && !mapError && <div className="map-hint">{t("Нажмите на карту, чтобы выбрать точку")}</div>}</div>;
}

export default function App() {
  const [language, setLanguageState] = useState(getLanguage);
  const changeLanguage = (nextLanguage) => {
    saveLanguage(nextLanguage);
    setLanguageState(nextLanguage);
    setError('');
    setToast('');
  };
  const [pendingInvite, setPendingInvite] = useState(() => {
    const inviteFromUrl = new URLSearchParams(window.location.search).get('invite');
    if (inviteFromUrl) {
      sessionStorage.setItem('saparsplit_pending_invite', inviteFromUrl);
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete('invite');
      window.history.replaceState({}, '', cleanUrl);
    }
    return inviteFromUrl || sessionStorage.getItem('saparsplit_pending_invite') || '';
  });
  const [auth, setAuth] = useState(() => { try { return JSON.parse(localStorage.getItem('ss_auth') || 'null'); } catch { return null; } });
  const [clientId, setClientId] = useState('');
  const [trips, setTrips] = useState([]);
  const [trip, setTrip] = useState(null);
  const [tab, setTab] = useState('overview');
  const [loading, setLoading] = useState(Boolean(auth?.token));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [modal, setModal] = useState('');
  const [memberInput, setMemberInput] = useState('');
  const [tripDraft, setTripDraft] = useState({ name: '', currency: '₸', date: new Date().toISOString().slice(0, 10), budget: '600000', members: [] });
  const [expenseDraft, setExpenseDraft] = useState(null);
  const [placeDraft, setPlaceDraft] = useState(null);
  const [expenseQuery, setExpenseQuery] = useState('');
  const [picking, setPicking] = useState(false);
  const [toast, setToast] = useState('');

  const showToast = (message) => { setToast(message); window.setTimeout(() => setToast(''), 2800); };
  const clearError = () => setError('');

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = t("SaparSplit — поездки и расходы");
    document.querySelector('meta[name="description"]')?.setAttribute('content', t("Планирование поездок и общих расходов"));
  }, [language]);

  const loadTrips = useCallback(async () => {
    const result = await api('/api/trips');
    setTrips(result);
    return result;
  }, []);

  const loadTrip = useCallback(async (id) => {
    const result = tripFromApi(await api(`/api/trips/${id}`));
    setTrip(result);
    setTab('overview');
    return result;
  }, []);

  const syncSelectedTrip = useCallback(async (id = trip?.id) => {
    if (!id) return;
    const [allTrips, current] = await Promise.all([loadTrips(), api(`/api/trips/${id}`)]);
    setTrips(allTrips);
    setTrip(tripFromApi(current));
  }, [loadTrips, trip?.id]);

  const loginWithGoogle = useCallback(async (credential) => {
    const result = await api('/api/auth/google', { method: 'POST', body: JSON.stringify({ credential }) });
    const nextAuth = { token: result.token, user: result.user };
    localStorage.setItem('ss_auth', JSON.stringify(nextAuth));
    setAuth(nextAuth);
  }, []);

  useEffect(() => {
    api('/api/config').then((config) => setClientId(config.googleClientId || '')).catch(() => setClientId(''));
  }, []);

  useEffect(() => {
    if (!auth?.token) { setLoading(false); setTrips([]); setTrip(null); return; }
    let active = true;
    setLoading(true);
    (async () => {
      const inviteToken = sessionStorage.getItem('saparsplit_pending_invite');
      let joinedTripId;
      if (inviteToken) {
        try {
          const joined = await api('/api/trips/join', { method: 'POST', body: JSON.stringify({ inviteToken }) });
          joinedTripId = joined.tripId;
          sessionStorage.removeItem('saparsplit_pending_invite');
          setPendingInvite('');
          const cleanUrl = new URL(window.location.href);
          cleanUrl.searchParams.delete('invite');
          window.history.replaceState({}, '', cleanUrl);
        } catch (reason) {
          if (reason.status === 400 || reason.status === 404) {
            sessionStorage.removeItem('saparsplit_pending_invite');
            setPendingInvite('');
            const cleanUrl = new URL(window.location.href);
            cleanUrl.searchParams.delete('invite');
            window.history.replaceState({}, '', cleanUrl);
          }
          if (active) setError(reason.status === 404 ? t("Ссылка-приглашение недействительна или отозвана.") : reason.message);
        }
      }
      const result = await loadTrips();
      if (!active) return;
      setTrips(result);
      if (joinedTripId) {
        await loadTrip(joinedTripId);
        if (active) showToast(t("Вы присоединились к поездке"));
      }
    })().catch((reason) => {
      if (!active) return;
      if (reason.status === 401) { localStorage.removeItem('ss_auth'); setAuth(null); }
      else setError(reason.message);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  // Initial session validation is intentionally tied to the token.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth?.token, loadTrips, loadTrip]);

  const total = useMemo(() => trip?.expenses.reduce((sum, item) => sum + item.amount, 0) || 0, [trip]);
  const balances = useMemo(() => getBalances(trip), [trip]);
  const settlements = useMemo(() => getSettlements(trip), [trip]);
  const filteredExpenses = useMemo(() => (trip?.expenses || []).filter((item) => `${item.desc} ${item.payer}`.toLowerCase().includes(expenseQuery.toLowerCase())), [trip, expenseQuery]);
  const currentPayer = trip?.members.find((member) => member.toLocaleLowerCase() === (auth?.user?.name || '').toLocaleLowerCase()) || trip?.members[0] || '';

  async function createTrip(event) {
    event.preventDefault(); clearError();
    if (!tripDraft.name.trim() || tripDraft.members.length < 2) { setError(t("Укажите название поездки и добавьте минимум двух участников.")); return; }
    setBusy(true);
    try {
      const result = await api('/api/trips', { method: 'POST', body: JSON.stringify({ ...tripDraft, name: tripDraft.name.trim(), budget: Number(tripDraft.budget) || 0 }) });
      const freshTrips = await loadTrips();
      setTrips(freshTrips);
      await loadTrip(result.id);
      setTripDraft({ name: '', currency: '₸', date: new Date().toISOString().slice(0, 10), budget: '600000', members: [] });
      setModal('');
      showToast(t("Поездка создана"));
    } catch (reason) { setError(reason.message); }
    finally { setBusy(false); }
  }

  function addDraftMember() {
    const member = memberInput.trim();
    if (member && !tripDraft.members.includes(member)) setTripDraft((current) => ({ ...current, members: [...current.members, member] }));
    setMemberInput('');
  }

  async function removeTrip(item) {
    if (!window.confirm(t('Удалить поездку «{name}» вместе с её расходами и местами?', { name: item.name }))) return;
    try {
      await api(`/api/trips/${item.id}`, { method: 'DELETE' });
      const next = await loadTrips(); setTrips(next);
      if (String(trip?.id) === String(item.id)) setTrip(null);
      showToast(t("Поездка удалена"));
    } catch (reason) { setError(reason.message); }
  }

  async function saveExpense(event) {
    event.preventDefault(); if (!trip || !expenseDraft) return;
    const participants = expenseDraft.participants || [];
    const payload = { ...expenseDraft, amount: Number(expenseDraft.amount), participants };
    if (!payload.desc.trim() || payload.amount <= 0 || !participants.length) { setError(t("Заполните описание, сумму и выберите участников.")); return; }
    setBusy(true); clearError();
    try {
      const path = `/api/trips/${trip.id}/expenses${expenseDraft.id ? `/${expenseDraft.id}` : ''}`;
      const result = await api(path, { method: expenseDraft.id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      if (!expenseDraft.id) payload.id = result.id;
      else payload.id = expenseDraft.id;
      setTrip((current) => ({ ...current, expenses: expenseDraft.id ? current.expenses.map((item) => item.id === payload.id ? payload : item) : [...current.expenses, payload] }));
      setModal(''); setExpenseDraft(null); showToast(expenseDraft.id ? t("Расход обновлён") : t("Расход добавлен"));
    } catch (reason) { setError(reason.message); }
    finally { setBusy(false); }
  }

  async function deleteExpense(item) {
    if (!window.confirm(t('Удалить расход «{name}»?', { name: item.desc }))) return;
    try {
      await api(`/api/trips/${trip.id}/expenses/${item.id}`, { method: 'DELETE' });
      setTrip((current) => ({ ...current, expenses: current.expenses.filter((expense) => expense.id !== item.id) }));
      showToast(t("Расход удалён"));
    } catch (reason) { setError(reason.message); }
  }

  async function duplicateExpense(item) {
    try {
      const duplicate = { ...item, id: undefined, desc: `${item.desc} ${t('(копия)')}` };
      const result = await api(`/api/trips/${trip.id}/expenses`, { method: 'POST', body: JSON.stringify(duplicate) });
      setTrip((current) => ({ ...current, expenses: [...current.expenses, { ...duplicate, id: result.id }] }));
      showToast(t("Расход скопирован"));
    } catch (reason) { setError(reason.message); }
  }

  async function savePlace(event) {
    event.preventDefault(); if (!trip || !placeDraft?.name.trim()) return;
    setBusy(true); clearError();
    try {
      const result = await api(`/api/trips/${trip.id}/places`, { method: 'POST', body: JSON.stringify({ ...placeDraft, id: undefined, cost: Number(placeDraft.cost) || 0, fav: Boolean(placeDraft.fav) }) });
      const place = { ...placeDraft, id: result.id, cost: Number(placeDraft.cost) || 0 };
      setTrip((current) => ({ ...current, places: [...current.places, place] }));
      setModal(''); setPlaceDraft(null); setPicking(false); showToast(t("Место добавлено"));
    } catch (reason) { setError(reason.message); }
    finally { setBusy(false); }
  }

  async function deletePlace(place) {
    try {
      await api(`/api/trips/${trip.id}/places/${place.id}`, { method: 'DELETE' });
      setTrip((current) => ({ ...current, places: current.places.filter((item) => item.id !== place.id) }));
    } catch (reason) { setError(reason.message); }
  }

  async function createInvite() {
    try {
      const result = await api(`/api/trips/${trip.id}/invite`, { method: 'POST' });
      setTrip((current) => ({ ...current, inviteToken: result.inviteToken }));
      showToast(t("Ссылка-приглашение обновлена"));
    } catch (reason) { setError(reason.message); }
  }

  async function removeCollaborator(person) {
    if (!window.confirm(t('Убрать {name} из поездки?', { name: person.name || person.email }))) return;
    try {
      const result = await api(`/api/trips/${trip.id}/members/${person.id}`, { method: 'DELETE' });
      setTrip((current) => ({ ...current, inviteToken: result.inviteToken, collaborators: current.collaborators.filter((item) => String(item.id) !== String(person.id)) }));
      showToast(t("Доступ отозван, ссылка-приглашение обновлена"));
    } catch (reason) { setError(reason.message); }
  }

  async function copyInviteLink() {
    const inviteUrl = `${window.location.origin}${window.location.pathname}?invite=${encodeURIComponent(trip.inviteToken)}`;
    try { await navigator.clipboard.writeText(inviteUrl); showToast(t("Ссылка скопирована")); }
    catch { window.prompt(t("Скопируйте ссылку-приглашение:"), inviteUrl); }
  }

  async function updateBudget(event) {
    event.preventDefault();
    try {
      const updated = await api(`/api/trips/${trip.id}`, { method: 'PUT', body: JSON.stringify({ budget: Number(event.currentTarget.elements.budget.value) }) });
      setTrip((current) => ({ ...current, budget: Number(updated.budget) }));
      showToast(t("Бюджет сохранён"));
    } catch (reason) { setError(reason.message); }
  }

  async function importTripFile(file) {
    if (!file) return;
    clearError(); setBusy(true);
    let createdTripId;
    try {
      const source = JSON.parse(await file.text());
      const members = Array.isArray(source.members) ? source.members : [];
      const name = source.name || source.tripName;
      if (typeof name !== 'string' || !name.trim() || !members.length) throw new Error(t("В файле должны быть название поездки и список участников."));
      const created = await api('/api/trips', { method: 'POST', body: JSON.stringify({
        name: name.trim(), currency: source.currency || '₸', date: source.date || source.tripDate || '',
        budget: Number(source.budget) || 600000, members,
      }) });
      createdTripId = created.id;
      for (const item of source.expenses || []) {
        const participants = Array.isArray(item.participants) && item.participants.length ? item.participants : members;
        await api(`/api/trips/${createdTripId}/expenses`, { method: 'POST', body: JSON.stringify({
          desc: item.desc || item.description || 'Расход', amount: Number(item.amount) || 0,
          payer: item.payer || members[0], participants, date: item.date || '', icon: item.icon || '💳',
        }) });
      }
      for (const item of source.places || []) {
        if (!item.name) continue;
        await api(`/api/trips/${createdTripId}/places`, { method: 'POST', body: JSON.stringify({
          name: item.name, cat: item.cat || item.category || 'Место', addr: item.addr || item.address || '',
          desc: item.desc || item.description || '', cost: Number(item.cost) || 0,
          fav: Boolean(item.fav ?? item.favorite), lat: item.lat ?? null, lng: item.lng ?? null,
        }) });
      }
      const freshTrips = await loadTrips(); setTrips(freshTrips);
      await loadTrip(createdTripId); showToast(t("Поездка импортирована"));
    } catch (reason) {
      if (createdTripId) await api(`/api/trips/${createdTripId}`, { method: 'DELETE' }).catch(() => {});
      setError(reason instanceof SyntaxError ? t("Файл не является корректным JSON.") : reason.message);
    } finally { setBusy(false); }
  }

  function exportTrip() {
    const blob = new Blob([JSON.stringify(trip, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = `saparsplit-${trip.name.replace(/[^\p{L}\p{N}-]+/gu, '-')}.json`; link.click(); URL.revokeObjectURL(url);
  }

  function logout() {
    localStorage.removeItem('ss_auth');
    window.google?.accounts?.id?.disableAutoSelect?.();
    setAuth(null); setTrip(null); setTrips([]); setError('');
  }

  const pickMapLocation = useCallback((coords) => {
    setPlaceDraft((current) => current ? { ...current, ...coords } : { name: '', cat: 'Место', addr: '', desc: '', cost: '', fav: false, ...coords });
    setPicking(false);
    setModal('place');
    showToast(t("Точка выбрана на карте"));
  }, []);

  if (loading) return <div className="loading-screen"><div className="brand-mark">S</div><span>{t("Загружаем SaparSplit…")}</span></div>;
  if (!auth?.token) return <main className="login-screen"><section className="login-card"><div className="login-language"><LanguageSwitcher value={language} onChange={changeLanguage} /></div><div className="brand-lockup"><div className="brand-mark">S</div><div>Sapar<span>Split</span></div></div><p className="eyebrow">{t("Поездки вместе — расчёты без путаницы")}</p><h1>{pendingInvite ? <>{t("Вас пригласили")}<br />{t("в совместную поездку")}</> : <>{t("Планируйте поездки")}<br />{t("и делите расходы")}</>}</h1><p className="login-copy">{pendingInvite ? t("Войдите через Google, чтобы присоединиться и вместе вести расходы и места.") : t("Соберите участников, записывайте общие траты и сразу видите, кто кому должен.")}</p><GoogleLogin clientId={clientId} onCredential={loginWithGoogle} language={language} />{error && <p className="inline-error">{t(error)}</p>}<div className="login-foot">{t("Вход через Google · данные поездок сохраняются в вашем аккаунте")}</div></section><div className="login-orbit orbit-one"/><div className="login-orbit orbit-two"/></main>;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand-lockup"><div className="brand-mark">S</div><div>Sapar<span>Split</span></div></div>
      {trip && <div className="active-trip"><span className="eyebrow">{t("ТЕКУЩАЯ ПОЕЗДКА")}</span><strong>{trip.name}</strong><small>{formatDate(trip.date)}</small></div>}
      <nav className="main-nav" aria-label={t("Разделы")}>
        {NAV.map(([key, icon, label]) => <button key={key} className={tab === key ? 'nav-item active' : 'nav-item'} onClick={() => setTab(key)} disabled={!trip}><span>{icon}</span>{t(label)}</button>)}
      </nav>
      <button className="nav-item trips-link" onClick={() => { setTrip(null); setTab('overview'); setError(''); }}><span>☷</span>{t("Мои поездки")}</button>
      <div className="sidebar-bottom"><div className="profile-row">{auth.user?.picture ? <img src={auth.user.picture} alt="" /> : <div className="avatar">{(auth.user?.name || t("П")).slice(0, 1)}</div>}<div className="profile-copy"><strong>{auth.user?.name || t("Профиль")}</strong><small>{auth.user?.email}</small></div></div><button className="logout-button" onClick={logout}>{t("Выйти из аккаунта")}</button></div>
    </aside>

    <main className="main-content">
      <header className="topbar"><div><span className="eyebrow">SAPARSPLIT / {trip ? trip.name : t("ПОЕЗДКИ")}</span><h1>{trip ? t(NAV.find(([key]) => key === tab)?.[2]) : t("Мои поездки")}</h1></div>{trip ? <div className="top-actions"><LanguageSwitcher value={language} onChange={changeLanguage} /><span className="member-count">♙ {countLabel('account', trip.collaborators?.length || 1)} · {countLabel('participant', trip.members.length)}</span><button className="button button-primary" onClick={() => { setExpenseDraft({ desc: '', amount: '', payer: currentPayer, participants: [...trip.members], date: new Date().toISOString().slice(0, 10), icon: ICONS[0] }); setModal('expense'); }}>{t("＋ Добавить расход")}</button></div> : <div className="top-actions"><LanguageSwitcher value={language} onChange={changeLanguage} /><span className="member-count">{auth.user?.email}</span></div>}</header>
      {error && <div className="notice"><span>{error}</span><button onClick={clearError}>×</button></div>}
      {!trip ? <TripsHome trips={trips} currentUserId={auth.user?.id} onCreate={() => { setModal('trip'); clearError(); }} onOpen={(item) => loadTrip(item.id).catch((reason) => setError(reason.message))} onDelete={removeTrip} /> : <TripContent
        trip={trip} tab={tab} total={total} balances={balances} settlements={settlements} filteredExpenses={filteredExpenses}
        expenseQuery={expenseQuery} setExpenseQuery={setExpenseQuery} onAddExpense={() => { setExpenseDraft({ desc: '', amount: '', payer: currentPayer, participants: [...trip.members], date: new Date().toISOString().slice(0, 10), icon: ICONS[0] }); setModal('expense'); }}
        onEditExpense={(item) => { setExpenseDraft({ ...item, participants: [...item.participants] }); setModal('expense'); }} onDeleteExpense={deleteExpense} onDuplicateExpense={duplicateExpense}
        onAddPlace={() => { setPlaceDraft({ name: '', cat: 'Место', addr: '', desc: '', cost: '', fav: false, lat: 43.2389, lng: 76.8897 }); setModal('place'); }} onDeletePlace={deletePlace} onExport={exportTrip} onImport={importTripFile} onSaveBudget={updateBudget} onCreateInvite={createInvite} onRemoveCollaborator={removeCollaborator} onCopyInvite={copyInviteLink}
        picking={picking} setPicking={setPicking} onMapPick={pickMapLocation}
      />}
    </main>

    {trip && <TripPrintReport trip={trip} total={total} balances={balances} settlements={settlements} />}

    {modal === 'trip' && <Modal title={t("Новая поездка")} onClose={() => setModal('')}><form className="form-stack" onSubmit={createTrip}><label>{t("Название поездки")}<input required autoFocus value={tripDraft.name} onChange={(event) => setTripDraft({ ...tripDraft, name: event.target.value })} placeholder={t("Например, Алматы — Стамбул")} /></label><div className="form-grid"><label>{t("Валюта")}<select value={tripDraft.currency} onChange={(event) => setTripDraft({ ...tripDraft, currency: event.target.value })}>{CURRENCIES.map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label>{t("Бюджет")}<input type="number" min="0" value={tripDraft.budget} onChange={(event) => setTripDraft({ ...tripDraft, budget: event.target.value })} /></label></div><label>{t("Дата")}<input type="date" value={tripDraft.date} onChange={(event) => setTripDraft({ ...tripDraft, date: event.target.value })} /></label><label>{t("Участники")}</label><div className="member-entry"><input value={memberInput} onChange={(event) => setMemberInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addDraftMember(); } }} placeholder={t("Имя участника")} /><button type="button" className="button button-muted" onClick={addDraftMember}>{t("Добавить")}</button></div><div className="tag-list">{tripDraft.members.map((name) => <span className="tag" key={name}>{name}<button type="button" onClick={() => setTripDraft({ ...tripDraft, members: tripDraft.members.filter((item) => item !== name) })}>×</button></span>)}</div><button className="button button-primary button-full" disabled={busy}>{busy ? t("Создаём…") : t("Создать поездку")}</button></form></Modal>}

    {modal === 'expense' && expenseDraft && <Modal title={expenseDraft.id ? t("Изменить расход") : t("Добавить расход")} onClose={() => { setModal(''); setExpenseDraft(null); }}><form className="form-stack" onSubmit={saveExpense}><label>{t("Описание")}<input required autoFocus value={expenseDraft.desc} onChange={(event) => setExpenseDraft({ ...expenseDraft, desc: event.target.value })} placeholder={t("Ужин, такси, билеты…")} /></label><div className="form-grid"><label>{t("Сумма")}<input required type="number" min="0.01" step="0.01" value={expenseDraft.amount} onChange={(event) => setExpenseDraft({ ...expenseDraft, amount: event.target.value })} /></label><label>{t("Дата")}<input type="date" value={expenseDraft.date || ''} onChange={(event) => setExpenseDraft({ ...expenseDraft, date: event.target.value })} /></label></div><label>{t("Кто оплатил")}<select value={expenseDraft.payer} onChange={(event) => setExpenseDraft({ ...expenseDraft, payer: event.target.value })}>{trip.members.map((member) => <option key={member}>{member}</option>)}</select></label><label>{t("Участники расходов")}</label><div className="check-list">{trip.members.map((member) => <label key={member} className="check-option"><input type="checkbox" checked={expenseDraft.participants.includes(member)} onChange={(event) => setExpenseDraft({ ...expenseDraft, participants: event.target.checked ? [...expenseDraft.participants, member] : expenseDraft.participants.filter((item) => item !== member) })} /><span>{member}</span></label>)}</div><div><label className="field-label">{t("Значок")}</label><div className="emoji-picker">{ICONS.map((icon) => <button type="button" className={expenseDraft.icon === icon ? 'emoji-option selected' : 'emoji-option'} key={icon} onClick={() => setExpenseDraft({ ...expenseDraft, icon })}>{icon}</button>)}</div></div><button className="button button-primary button-full" disabled={busy}>{busy ? t("Сохраняем…") : t("Сохранить расход")}</button></form></Modal>}

    {modal === 'place' && placeDraft && <Modal title={t("Добавить место")} wide onClose={() => { setModal(''); setPlaceDraft(null); setPicking(false); }}><form className="form-stack" onSubmit={savePlace}><div className="form-grid"><label>{t("Название")}<input autoFocus required value={placeDraft.name} onChange={(event) => setPlaceDraft({ ...placeDraft, name: event.target.value })} placeholder={t("Например, Медеу")} /></label><label>{t("Категория")}<select value={placeDraft.cat} onChange={(event) => setPlaceDraft({ ...placeDraft, cat: event.target.value })}>{['Место', 'Достопримечательность', 'Ресторан', 'Отель', 'Покупки', 'Развлечение', 'Аэропорт'].map((item) => <option key={item} value={item}>{t(item)}</option>)}</select></label></div><div className="form-grid"><label>{t("Адрес")}<input value={placeDraft.addr} onChange={(event) => setPlaceDraft({ ...placeDraft, addr: event.target.value })} /></label><label>{t("Планируемые расходы")}<input type="number" min="0" value={placeDraft.cost} onChange={(event) => setPlaceDraft({ ...placeDraft, cost: event.target.value })} /></label></div><label>{t("Заметка")}<textarea rows="2" value={placeDraft.desc} onChange={(event) => setPlaceDraft({ ...placeDraft, desc: event.target.value })} /></label><div className="form-grid"><label>{t("Широта")}<input type="number" step="any" value={placeDraft.lat} onChange={(event) => setPlaceDraft({ ...placeDraft, lat: Number(event.target.value) })} /></label><label>{t("Долгота")}<input type="number" step="any" value={placeDraft.lng} onChange={(event) => setPlaceDraft({ ...placeDraft, lng: Number(event.target.value) })} /></label></div><button type="button" className="button button-muted" onClick={() => { setModal(''); setTab('places'); setPicking(true); }}>{t("⌖ Выбрать точку на карте")}</button><p className="field-help">{t("Координаты можно указать вручную или выбрать на карте.")}</p><label className="check-option"><input type="checkbox" checked={placeDraft.fav} onChange={(event) => setPlaceDraft({ ...placeDraft, fav: event.target.checked })} /><span>{t("В избранное")}</span></label><button className="button button-primary button-full" disabled={busy}>{busy ? t("Сохраняем…") : t("Добавить место")}</button></form></Modal>}
    {toast && <div className="toast">✓ {toast}</div>}
  </div>;
}

function TripsHome({ trips, currentUserId, onCreate, onOpen, onDelete }) {
  return <div className="home-view">
    <div className="welcome-row"><div><span className="eyebrow">{t("ВАШИ ПУТЕШЕСТВИЯ")}</span><h2>{t("Хорошая поездка начинается с плана.")}</h2><p>{t("Добавьте поездку и ведите общие расходы в одном месте.")}</p></div><button className="button button-primary" onClick={onCreate}>{t("＋ Новая поездка")}</button></div>
    {trips.length ? <div className="trip-grid">{trips.map((item) => <Card className="trip-card" key={item.id}>
      <div className="trip-card-icon">✈</div><h3>{item.name}</h3>
      <p>{formatDate(item.date)} · {countLabel('participant', item.members?.length || 0)} · {item.role === 'owner' ? t("владелец") : t("совместная поездка")}</p>
      <div className="trip-card-bottom"><span>{item.currency}{t(" · бюджет ")}{money(item.budget, '')}</span><div><button className="button button-muted button-small" onClick={() => onOpen(item)}>{t("Открыть")}</button>{String(item.ownerId) === String(currentUserId) && <button className="icon-button danger-icon" onClick={() => onDelete(item)} title={t("Удалить")}>×</button>}</div></div>
    </Card>)}</div> : <div className="empty-home"><div className="empty-illustration">✈️</div><h3>{t("Пока нет поездок")}</h3><p>{t("Создайте поездку и добавьте участников, чтобы вести общий счёт.")}</p><button className="button button-primary" onClick={onCreate}>{t("Создать первую поездку")}</button></div>}
  </div>;
}

function TripContent({ trip, tab, total, balances, settlements, filteredExpenses, expenseQuery, setExpenseQuery, onAddExpense, onEditExpense, onDeleteExpense, onDuplicateExpense, onAddPlace, onDeletePlace, onExport, onImport, onSaveBudget, onCreateInvite, onRemoveCollaborator, onCopyInvite, picking, setPicking, onMapPick }) {
  const budgetRatio = trip.budget ? Math.min(100, total / trip.budget * 100) : 0;
  const spendingByMember = trip.members.map((member) => ({ member, total: trip.expenses.filter((item) => item.payer === member).reduce((sum, item) => sum + item.amount, 0) })).sort((a, b) => b.total - a.total);
  const spendingByIcon = Object.entries(trip.expenses.reduce((groups, item) => { const key = item.icon || '💳'; groups[key] = (groups[key] || 0) + item.amount; return groups; }, {})).sort((a, b) => b[1] - a[1]);

  if (tab === 'overview') return <div className="content-stack"><div className="stats-grid"><Stat label={t("Общие расходы")} value={money(total, trip.currency)} hint={countLabel('entry', trip.expenses.length)} icon="↗" /><Stat label={t("Остаток бюджета")} value={money(Math.max(0, trip.budget - total), trip.currency)} hint={t('Из {amount}', { amount: money(trip.budget, trip.currency) })} icon="◉" /><Stat label={t("Участники")} value={trip.members.length} hint={t("в этой поездке")} icon="♙" /><Stat label={t("Сохранённые места")} value={trip.places.length} hint={t("в маршруте")} icon="⌖" /></div><div className="content-columns"><Card><div className="section-heading"><div><h2>{t("Бюджет поездки")}</h2><p>{t("Использовано ")}{budgetRatio.toFixed(0)}{t("% бюджета")}</p></div><span className="progress-label">{money(total, trip.currency)}</span></div><div className="progress-track"><div style={{ width: `${budgetRatio}%` }} /></div><div className="progress-caption"><span>0</span><span>{t("Лимит ")}{money(trip.budget, trip.currency)}</span></div><div className="member-spending">{spendingByMember.map((item) => <div className="member-spend-row" key={item.member}><div className="avatar">{item.member.slice(0, 1)}</div><span>{item.member}</span><strong>{money(item.total, trip.currency)}</strong></div>)}</div></Card><Card><div className="section-heading"><div><h2>{t("Последние расходы")}</h2><p>{t("Недавно добавленные")}</p></div><button className="text-button" onClick={onAddExpense}>{t("Добавить +")}</button></div><ExpenseList items={[...trip.expenses].slice(-5).reverse()} currency={trip.currency} onEdit={onEditExpense} onDelete={onDeleteExpense} onDuplicate={onDuplicateExpense} compact /></Card></div><div className="content-columns bottom-row"><Card><div className="section-heading"><div><h2>{t("Расчёты участников")}</h2><p>{t("Кому вернуть деньги")}</p></div></div>{settlements.length ? settlements.slice(0, 4).map((item, index) => <div className="settlement-row" key={`${item.from}-${item.to}-${index}`}><span className="settlement-avatar">{item.from.slice(0, 1)}</span><strong>{item.from}</strong><span className="settlement-arrow">→</span><span className="settlement-avatar teal-avatar">{item.to.slice(0, 1)}</span><strong>{item.to}</strong><b>{money(item.amount, trip.currency)}</b></div>) : <p className="muted-copy">{t("Пока нет расходов для расчёта.")}</p>}</Card><Card><div className="section-heading"><div><h2>{t("Места поездки")}</h2><p>{countLabel('place', trip.places.length)}</p></div><button className="text-button" onClick={onAddPlace}>{t("Добавить +")}</button></div>{trip.places.length ? trip.places.slice(0, 4).map((place) => <div className="place-mini" key={place.id}><span className="place-pin">⌖</span><div><strong>{place.name}</strong><small>{place.addr || t(place.cat || 'Место')}</small></div>{place.fav && <span>★</span>}</div>) : <p className="muted-copy">{t("Сохраняйте отели, кафе и достопримечательности.")}</p>}</Card></div></div>;

  if (tab === 'expenses') return <div className="content-stack"><div className="section-heading page-section-heading"><div><h2>{t("Все расходы")}</h2><p>{t("Учитывайте общие траты поездки")}</p></div><button className="button button-primary" onClick={onAddExpense}>{t("＋ Добавить расход")}</button></div><div className="search-field"><span>⌕</span><input value={expenseQuery} onChange={(event) => setExpenseQuery(event.target.value)} placeholder={t("Найти расход или участника")} /></div><Card><ExpenseList items={[...filteredExpenses].reverse()} currency={trip.currency} onEdit={onEditExpense} onDelete={onDeleteExpense} onDuplicate={onDuplicateExpense} /></Card><div className="total-line"><span>{t("Всего расходов")}</span><strong>{money(total, trip.currency)}</strong></div></div>;

  if (tab === 'balances') return <div className="content-stack"><div className="section-heading page-section-heading"><div><h2>{t("Баланс участников")}</h2><p>{t("Сумма — сколько участнику должны или сколько он должен")}</p></div></div><div className="balance-grid">{Object.entries(balances).map(([member, amount]) => <Card className="balance-card" key={member}><div className="avatar large-avatar">{member.slice(0, 1)}</div><strong>{member}</strong><span className={amount >= 0 ? 'positive' : 'negative'}>{amount >= 0 ? '+' : '−'}{money(Math.abs(amount), trip.currency)}</span><small>{amount >= 0.01 ? t("ему должны") : amount <= -0.01 ? t("должен") : t("расчёт закрыт")}</small></Card>)}</div><Card><div className="section-heading"><div><h2>{t("Кто кому переводит")}</h2><p>{t("Оптимальное количество переводов между участниками")}</p></div></div>{settlements.length ? settlements.map((item, index) => <div className="settlement-row full-settlement" key={`${item.from}-${item.to}-${index}`}><span className="settlement-avatar">{item.from.slice(0, 1)}</span><strong>{item.from}</strong><span className="settlement-copy">{t("переводит")}</span><span className="settlement-avatar teal-avatar">{item.to.slice(0, 1)}</span><strong>{item.to}</strong><b>{money(item.amount, trip.currency)}</b></div>) : <div className="settled-state"><span>✓</span><strong>{t("Все расчёты закрыты")}</strong><p>{t("Добавьте расходы, чтобы увидеть баланс участников.")}</p></div>}</Card></div>;

  if (tab === 'places') return <div className="content-stack"><div className="section-heading page-section-heading"><div><h2>{t("Места поездки")}</h2><p>{t("Отмечайте отели, кафе и достопримечательности на карте")}</p></div><div className="button-row"><button className={picking ? 'button button-muted' : 'button button-muted'} onClick={() => setPicking(!picking)}>{picking ? t("Отменить выбор") : t("⌖ Выбрать точку")}</button><button className="button button-primary" onClick={onAddPlace}>{t("＋ Добавить место")}</button></div></div><MapCanvas active places={trip.places} picking={picking} onPick={onMapPick} /><div className="place-grid">{trip.places.length ? trip.places.map((place) => <Card className="saved-place" key={place.id}><div className="place-card-icon">⌖</div><div className="place-card-title"><div><span className="eyebrow">{t(place.cat || 'Место')}</span><h3>{place.name}</h3></div><button className="icon-button danger-icon" onClick={() => onDeletePlace(place)} title={t("Удалить место")}>×</button></div><p>{place.addr || place.desc || t("Адрес не указан")}</p>{place.cost > 0 && <span className="place-cost">{t("Планируемые расходы · ")}{money(place.cost, trip.currency)}</span>}{place.fav && <span className="favorite-tag">{t("★ Избранное")}</span>}</Card>) : <Card className="empty-card"><div className="empty-illustration">⌖</div><h3>{t("Места ещё не добавлены")}</h3><p>{t("Добавьте точки, чтобы сохранить план маршрута.")}</p><button className="button button-primary" onClick={onAddPlace}>{t("Добавить первое место")}</button></Card>}</div></div>;

  if (tab === 'analytics') return <div className="content-stack"><div className="section-heading page-section-heading"><div><h2>{t("Аналитика расходов")}</h2><p>{t("Сводка по расходам и участникам")}</p></div></div><div className="stats-grid"><Stat label={t("Расходы всего")} value={money(total, trip.currency)} hint={countLabel('entry', trip.expenses.length)} icon="↗" /><Stat label={t("Средний расход")} value={money(trip.expenses.length ? total / trip.expenses.length : 0, trip.currency)} hint={t("на одну запись")} icon="◉" /><Stat label={t("Самый большой расход")} value={money(Math.max(0, ...trip.expenses.map((item) => item.amount)), trip.currency)} hint={trip.expenses.length ? [...trip.expenses].sort((a, b) => b.amount - a.amount)[0].desc : t("пока нет расходов")} icon="↑" /><Stat label={t("Бюджет использован")} value={`${budgetRatio.toFixed(0)}%`} hint={money(trip.budget, trip.currency)} icon="▥" /></div><div className="content-columns"><Card><div className="section-heading"><div><h2>{t("Расходы по значкам")}</h2><p>{t("Группировка по выбранному значку")}</p></div></div>{spendingByIcon.length ? <div className="chart-list">{spendingByIcon.map(([icon, amount]) => <div className="chart-row" key={icon}><span>{icon}</span><div className="chart-bar-wrap"><div className="chart-bar-label"><strong>{money(amount, trip.currency)}</strong><small>{(amount / total * 100 || 0).toFixed(0)}%</small></div><div className="progress-track"><div style={{ width: `${amount / total * 100 || 0}%` }} /></div></div></div>)}</div> : <p className="muted-copy">{t("Добавьте расходы, чтобы увидеть аналитику.")}</p>}</Card><Card><div className="section-heading"><div><h2>{t("Кто сколько оплатил")}</h2><p>{t("Сумма записанных платежей")}</p></div></div>{spendingByMember.map((item) => <div className="member-spend-row analytics-member" key={item.member}><div className="avatar">{item.member.slice(0, 1)}</div><span>{item.member}</span><strong>{money(item.total, trip.currency)}</strong></div>)}</Card></div></div>;

  const inviteUrl = trip.inviteToken ? `${window.location.origin}${window.location.pathname}?invite=${encodeURIComponent(trip.inviteToken)}` : '';
  return <div className="content-stack">
    <div className="section-heading page-section-heading"><div><h2>{t("Настройки поездки")}</h2><p>{t("Бюджет, приглашения и данные поездки")}</p></div></div>
    <div className="settings-grid">
      <Card><div className="section-heading"><div><h2>{t("Лимит расходов")}</h2><p>{t("Задайте общий бюджет поездки")}</p></div></div><form className="budget-form" onSubmit={onSaveBudget}><label>{t("Бюджет в ")}{trip.currency}<input name="budget" type="number" min="0" defaultValue={trip.budget} /></label><button className="button button-primary">{t("Сохранить бюджет")}</button></form><div className="settings-summary"><span>{t("Потрачено")}</span><strong>{money(total, trip.currency)}</strong><span>{t("Осталось")}</span><strong>{money(Math.max(0, trip.budget - total), trip.currency)}</strong></div></Card>
      <Card><div className="section-heading"><div><h2>{t("Участники поездки")}</h2><p>{countLabel('person', trip.members.length)}</p></div></div><div className="member-spending">{trip.members.map((member) => <div className="member-spend-row" key={member}><div className="avatar">{member.slice(0, 1)}</div><span>{member}</span><small>{countLabel('expense', trip.expenses.filter((item) => item.participants.includes(member)).length)}</small></div>)}</div><p className="field-help">{t("Эти имена используются для распределения расходов между участниками.")}</p></Card>
    </div>
    <Card className="shared-access">
      <div className="section-heading"><div><h2>{t("Совместный доступ")}</h2><p>{t("Аккаунты с доступом к этой поездке могут добавлять и менять расходы и места.")}</p></div><span className="access-badge">{countLabel('account', trip.collaborators?.length || 1)}</span></div>
      {trip.isOwner && <div className="invite-box">{inviteUrl ? <><input aria-label={t("Ссылка-приглашение")} readOnly value={inviteUrl} /><button className="button button-primary" onClick={onCopyInvite}>{t("Копировать ссылку")}</button><button className="button button-muted" onClick={onCreateInvite}>{t("Обновить ссылку")}</button></> : <button className="button button-primary" onClick={onCreateInvite}>{t("Создать ссылку-приглашение")}</button>}</div>}
      {!trip.isOwner && <p className="field-help collaborator-note">{t("Вы присоединились к поездке по приглашению. Доступом управляет её владелец.")}</p>}
      <div className="collaborator-list">{(trip.collaborators || []).map((person) => <div className="collaborator-row" key={person.id}>{person.picture ? <img src={person.picture} alt="" /> : <div className="avatar">{(person.name || person.email || '?').slice(0, 1)}</div>}<div><strong>{person.name || t("Пользователь")}</strong><small>{person.email}</small></div><span className={person.role === 'owner' ? 'owner-label' : 'member-label'}>{person.role === 'owner' ? t("Владелец") : t("Участник")}</span>{trip.isOwner && person.role !== 'owner' && <button className="icon-button danger-icon" title={t("Отозвать доступ")} onClick={() => onRemoveCollaborator(person)}>×</button>}</div>)}</div>
    </Card>
    <Card className="settings-tools"><div><h2>{t("Данные поездки")}</h2><p>{t("Сохраните копию или перенесите поездку из JSON-файла.")}</p></div><div className="button-row"><button className="button button-muted" onClick={() => window.print()}>{t("▤ Сохранить PDF")}</button><button className="button button-muted" onClick={onExport}>{t("↓ Экспорт JSON")}</button><label className="button button-muted upload-label">{t("↑ Импорт JSON")}<input type="file" accept="application/json,.json" onChange={(event) => { onImport(event.target.files?.[0]); event.target.value = ''; }} /></label></div></Card>
    <Card className="about-card"><div className="brand-mark">S</div><div><strong>SaparSplit</strong><p>{t("Ваши поездки и расходы синхронизируются с PostgreSQL и доступны после входа в аккаунт.")}</p></div></Card>
  </div>;
}

function TripPrintReport({ trip, total, balances, settlements }) {
  const remaining = Math.max(0, trip.budget - total);

  return <article className="print-report">
    <header className="print-report-header">
      <div><p className="print-kicker">{t("SAPARSPLIT · ОТЧЁТ О ПОЕЗДКЕ")}</p><h1>{trip.name}</h1><p>{formatDate(trip.date)} · {countLabel('participant', trip.members.length)}</p></div>
      <strong>Sapar<span>Split</span></strong>
    </header>
    <section className="print-summary">
      <div><span>{t("Расходы всего")}</span><strong>{money(total, trip.currency)}</strong></div>
      <div><span>{t("Бюджет")}</span><strong>{money(trip.budget, trip.currency)}</strong></div>
      <div><span>{t("Остаток бюджета")}</span><strong>{money(remaining, trip.currency)}</strong></div>
      <div><span>{t("Расходов")}</span><strong>{trip.expenses.length}</strong></div>
    </section>
    <section className="print-section">
      <h2>{t("Баланс участников")}</h2>
      <div className="print-balances">{Object.entries(balances).map(([member, amount]) => <div key={member}><strong>{member}</strong><span>{amount >= 0 ? t("получит") : t("должен")} {money(Math.abs(amount), trip.currency)}</span></div>)}</div>
      <h3>{t("Кто кому переводит")}</h3>
      {settlements.length ? <ul className="print-settlements">{settlements.map((item, index) => <li key={`${item.from}-${item.to}-${index}`}><span>{item.from} → {item.to}</span><strong>{money(item.amount, trip.currency)}</strong></li>)}</ul> : <p>{t("Все расчёты закрыты.")}</p>}
    </section>
    <section className="print-section">
      <h2>{t("Расходы")}</h2>
      {trip.expenses.length ? <table><thead><tr><th>{t("Дата")}</th><th>{t("Расход")}</th><th>{t("Оплатил")}</th><th>{t("Участники")}</th><th>{t("Сумма")}</th></tr></thead><tbody>{trip.expenses.map((item) => <tr key={item.id}><td>{item.date ? formatDate(item.date) : '—'}</td><td>{item.icon || '💳'} {item.desc}</td><td>{item.payer || '—'}</td><td>{item.participants?.join(', ') || '—'}</td><td>{money(item.amount, trip.currency)}</td></tr>)}</tbody></table> : <p>{t("Расходов пока нет.")}</p>}
    </section>
    <section className="print-section">
      <h2>{t("Места поездки")}</h2>
      {trip.places.length ? <table><thead><tr><th>{t("Место")}</th><th>{t("Категория")}</th><th>{t("Адрес и заметка")}</th><th>{t("Планируемые расходы")}</th></tr></thead><tbody>{trip.places.map((place) => <tr key={place.id}><td>{place.name}{place.fav ? ' ★' : ''}</td><td>{place.cat ? t(place.cat) : '—'}</td><td>{[place.addr, place.desc].filter(Boolean).join(' · ') || '—'}</td><td>{place.cost ? money(place.cost, trip.currency) : '—'}</td></tr>)}</tbody></table> : <p>{t("Места пока не добавлены.")}</p>}
    </section>
    <footer className="print-report-footer">{t("Создано в SaparSplit")}</footer>
  </article>;
}

function ExpenseList({ items, currency, onEdit, onDelete, onDuplicate, compact = false }) {
  if (!items.length) return <div className="empty-list"><span>◌</span><strong>{t("Пока нет расходов")}</strong><small>{t("Добавьте расход — и баланс обновится автоматически.")}</small></div>;
  return <div className="expense-list">{items.map((item) => <div className="expense-row" key={item.id}><div className="expense-icon">{item.icon || '💳'}</div><div className="expense-main"><strong>{item.desc}</strong><small><span className="payer-label">{item.payer}</span>{item.date ? ` · ${formatDate(item.date)}` : ''}{item.date ? ' · ' : ''}{countLabel('participant', item.participants?.length || 0)}</small></div><div className="expense-amount"><strong>{money(item.amount, currency)}</strong><small>{item.participants?.length ? t('По {amount}', { amount: money(item.amount / item.participants.length, currency) }) : ''}</small></div><div className="expense-actions"><button title={t("Изменить")} onClick={() => onEdit(item)}>✎</button>{!compact && <button title={t("Копировать")} onClick={() => onDuplicate(item)}>⧉</button>}<button title={t("Удалить")} onClick={() => onDelete(item)}>×</button></div></div>)}</div>;
}
