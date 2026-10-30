'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, messageFor, type Role } from '@/lib/api';
import { arrayEntry, DEPARTURE_FACTS, initialDocument, LABELS, object, TOUR_CONTRACT, type Collection, type ContentKind, type Document, type Entity, type Item, type Value } from '@/lib/editorial';

const TITLES: Record<Collection, string> = { tours: 'Туры', departures: 'Выезды', content: 'Материалы' };
const KINDS: [ContentKind, string][] = [['organizer', 'Организатор'], ['report', 'Отчёт'], ['review', 'Отзыв'], ['legal', 'Правовой документ']];
type Fail = (e: unknown) => void;

export function EditorialWorkspace({ collection, role, fail, onDirtyChange }: { collection: Collection; role: Role; fail: Fail; onDirtyChange: (dirty: boolean) => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [tours, setTours] = useState<Item[]>([]);
  const [selected, setSelected] = useState<Item | null>(null);
  const [creating, setCreating] = useState(false);
  const [slug, setSlug] = useState('');
  const [tourId, setTourId] = useState('');
  const [kind, setKind] = useState<ContentKind>('organizer');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    const result = await api<{ tours?: Item[]; departures?: Item[]; items?: Item[] }>('GET', `/${collection}`);
    setItems(result.tours ?? result.departures ?? result.items ?? []);
  }, [collection]);
  useEffect(() => { let active = true;
    api<{ tours?: Item[]; departures?: Item[]; items?: Item[] }>('GET', `/${collection}`).then(r => {
      if (active) setItems(r.tours ?? r.departures ?? r.items ?? []);
    }, fail);
    if (collection === 'departures') api<{ tours: Item[] }>('GET', '/tours').then(r => { if (active) setTours(r.tours); }, fail);
    return () => { active = false; };
  }, [collection, fail]);
  async function create(e: React.FormEvent) {
    e.preventDefault(); if (busy) return; setBusy(true); setError('');
    try {
      const r = await api<{ id: string }>('POST', `/${collection}`, { slug, ...(collection === 'content' ? { kind } : {}), ...(collection === 'departures' ? { tourId } : {}) });
      await load(); setCreating(false); setSelected({ id: r.id, slug, kind, publishedVersion: null, draftRevision: collection === 'departures' ? 1 : null }); setSlug('');
    } catch (e) { setError(messageFor(e)); failIfAuth(e, fail); } finally { setBusy(false); }
  }
  if (selected) return <EntityEditor key={selected.id} collection={collection} item={selected} role={role} fail={fail} onDirtyChange={onDirtyChange}
    onClose={() => { setSelected(null); void load().catch(fail); }} />;
  return <section className="card">
    <div className="row spread"><h2>{TITLES[collection]}</h2><button onClick={() => setCreating(v => !v)}>Создать</button></div>
    {creating && <form onSubmit={create} className="create-form">
      <label>Адрес (латиница, цифры и дефис)<input required pattern="[a-z0-9][a-z0-9-]{0,99}" maxLength={100} value={slug} onChange={e => setSlug(e.target.value)} /></label>
      {collection === 'content' && <label>Тип<select value={kind} onChange={e => setKind(e.target.value as ContentKind)}>{KINDS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select></label>}
      {collection === 'departures' && <label>Шаблон тура<select required value={tourId} onChange={e => setTourId(e.target.value)}><option value="">Выберите тур</option>{tours.map(t => <option key={t.id} value={t.id}>{t.title ?? t.slug}</option>)}</select></label>}
      <button disabled={busy}>{busy ? 'Создание…' : 'Создать черновик'}</button>
    </form>}
    {error && <p role="alert" className="error">{error}</p>}
    {!items ? <p>Загрузка…</p> : items.length === 0 ? <p className="muted">Пока ничего нет. Создайте первый черновик.</p> : <div className="table-scroll"><table className="editorial-table">
      <thead><tr><th>Материал</th><th>Публикация</th><th>Черновик</th><th /></tr></thead><tbody>{items.map(i => <tr key={i.id}>
        <td><strong>{i.title ?? i.slug}</strong><br /><span className="muted">{i.kind ? `${KINDS.find(([k]) => k === i.kind)?.[1]} · ` : ''}{i.slug}</span></td>
        <td data-label="Публикация">{i.publishedVersion ? `Версия ${i.publishedVersion}` : 'Не опубликован'}</td><td data-label="Черновик">{i.draftRevision ?? '—'}</td>
        <td><button className="secondary" onClick={() => setSelected(i)}>Редактировать</button></td>
      </tr>)}</tbody></table></div>}
    {collection === 'departures' && <DepartureControls role={role} fail={fail} />}
  </section>;
}
function failIfAuth(e: unknown, fail: Fail) { if (e instanceof ApiError && e.status === 401) fail(e); }

function EntityEditor({ collection, item, role, fail, onClose, onDirtyChange }: { collection: Collection; item: Item; role: Role; fail: Fail; onClose: () => void; onDirtyChange: (dirty: boolean) => void }) {
  const [entity, setEntity] = useState<Entity | null>(null);
  const [document, setDocument] = useState<Document | null>(null);
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [effectiveOn, setEffectiveOn] = useState('');
  const [approval, setApproval] = useState('');
  const [contentInvalid, setContentInvalid] = useState(false);
  const [readSerial, setReadSerial] = useState(0);
  const legal = collection === 'content' && item.kind === 'legal';
  const base = `/${collection}/${item.id}`;
  const read = useCallback(async () => {
    const r = await api<Record<string, unknown>>('GET', base);
    const next = { ...r, row: r[collection === 'tours' ? 'tour' : collection === 'departures' ? 'departure' : 'content'] } as unknown as Entity;
    const doc = next.draft?.document ?? next.publishedDocument ?? initialDocument(collection, item);
    return { next, doc };
  }, [base, collection, item]);
  const applyRead = useCallback(({ next, doc }: { next: Entity; doc: Document }) => { setEntity(next); setDocument(doc); setSaved(JSON.stringify(doc)); setConfirmPublish(false); setContentInvalid(false); setReadSerial(v => v + 1); }, []);
  useEffect(() => { let active = true; read().then(r => { if (active) applyRead(r); }, e => { if (active) { setError(messageFor(e)); failIfAuth(e, fail); } }); return () => { active = false; }; }, [read, applyRead, fail]);
  const dirty = !!document && JSON.stringify(document) !== saved;
  useEffect(() => { onDirtyChange(dirty || contentInvalid); return () => onDirtyChange(false); }, [dirty, contentInvalid, onDirtyChange]);
  useEffect(() => { if (!dirty) return; const warn = (e: BeforeUnloadEvent) => e.preventDefault(); window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty]);
  async function run(action: 'save' | 'publish') {
    if (!document || !entity || pending.current) return; pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      if (action === 'save') {
        const result = await api<{ revision: number }>('PUT', `${base}/draft`, { expectedRevision: entity.draft?.revision ?? 0, document });
        setEntity({ ...entity, draft: { revision: result.revision, document } }); setSaved(JSON.stringify(document)); setConfirmPublish(false); setNotice(`Черновик ${result.revision} сохранён. На сайте изменений нет.`);
      } else {
        await api('POST', `${base}/${legal ? 'publish-legal' : 'publish'}`, { expectedDraftRevision: entity.draft?.revision ?? 0, expectedPublishedVersion: entity.revisions[0]?.version ?? 0, ...(legal ? { effectiveOn, approval } : {}) });
        await read().then(applyRead); setNotice('Публикация подтверждена. Опубликованная версия прочитана из API. Продажи не открывались.');
      }
    } catch (e) { setError(messageFor(e)); failIfAuth(e, fail); } finally { pending.current = false; setBusy(false); }
  }
  if (!entity || !document) return <section className="card"><button className="secondary" onClick={onClose}>← К списку</button><p role="status">{error || 'Загрузка…'}</p></section>;
  const content = object(document.content);
  return <section className="card editor">
    <div className="row spread"><button className="secondary" disabled={busy} onClick={() => { if (!dirty && !contentInvalid || window.confirm('Есть несохранённые изменения. Закрыть редактор?')) onClose(); }}>← К списку</button><span className="muted">{item.slug} · {dirty || contentInvalid ? 'Есть несохранённые изменения' : 'Сохранено'}</span></div>
    <h2>{legal ? 'Правовой документ' : 'Редактор'} · {String(document.title ?? document.name ?? document.authorName ?? item.slug)}</h2>
    <p className="muted">Черновик {entity.draft?.revision ?? 'ещё не сохранён'} · Опубликовано: {entity.revisions[0] ? `v${entity.revisions[0].version}` : 'нет'}. Цена применяется к новым заявкам.</p>
    {error && <div className="error" role="alert">{error} <button className="secondary" disabled={busy} onClick={() => { if (!dirty || window.confirm('Загрузить серверную версию и сбросить несохранённые изменения?')) void read().then(r => { applyRead(r); setError(''); }, fail); }}>Загрузить заново</button></div>}
    {notice && <p className="ok" role="status">{notice}</p>}
    <fieldset disabled={busy} className="editor-fields">
      <div className="field-grid">{Object.entries(document).filter(([key]) => !['contract','content','organizers'].includes(key)).map(([key, value]) =>
        <ValueField key={key} name={key} value={value} disabled={key === 'slug' && entity.revisions.length > 0} onChange={v => setDocument({ ...document, [key]: v })} />)}</div>
      {collection === 'tours' && document.isListed === undefined && <ValueField name="isListed" value={entity.row.is_listed === true} onChange={v => setDocument({ ...document, isListed: v })} />}
      {collection === 'departures' && <ValueField name="organizers" value={document.organizers ?? []} onChange={v => setDocument({ ...document, organizers: v })} />}
      {!legal && collection !== 'departures' && <MediaReferences kind={collection === 'tours' ? 'tour' : item.kind ?? 'report'} content={content} onChange={v => setDocument({ ...document, content: v })} />}
      <details open><summary>Текст и SEO</summary><div className="field-grid">{(legal ? ['body'] : collection === 'tours' ? ['heading','shortDescription','description','sortOrder','updatedAt'] : item.kind === 'organizer' ? ['phone','bio'] : ['description','sortOrder','updatedAt']).map(key =>
        <ValueField key={key} name={key} value={content[key] ?? (key === 'sortOrder' ? 0 : '')} onChange={v => setDocument({ ...document, content: { ...content, [key]: v } })} />)}</div>
        {collection === 'tours' && <ValueField name="seo" value={{ title: '', description: '', ...object(content.seo) }} onChange={v => setDocument({ ...document, content: { ...content, seo: v } })} />}
        <JsonSection key={readSerial} label="Дополнительные поля содержимого" value={content} onValidity={setContentInvalid} onChange={v => setDocument({ ...document, content: v })} />
      </details>
      {collection !== 'content' && <details><summary>Условия тура и выезда</summary><p className="muted">Изменение расписания или условий при наличии заказов требует отдельного этапа и будет отклонено сервером.</p>
        {document.contract === null ? <button className="secondary" onClick={() => setDocument({ ...document, contract: collection === 'tours' ? structuredClone(TOUR_CONTRACT) : { tour: structuredClone(TOUR_CONTRACT), departure: structuredClone(DEPARTURE_FACTS) } })}>Заполнить условия</button>
          : <>{collection === 'departures' ? <>{(['tour','departure'] as const).map(key => object(document.contract)[key] === null
            ? <button key={key} className="secondary" onClick={() => setDocument({ ...document, contract: { ...object(document.contract), [key]: structuredClone(key === 'tour' ? TOUR_CONTRACT : DEPARTURE_FACTS) } })}>{key === 'tour' ? 'Заполнить программу тура' : 'Заполнить условия выезда'}</button>
            : <ValueField key={key} name={key === 'tour' ? 'Программа тура' : 'Условия выезда'} value={object(document.contract)[key] ?? null} onChange={v => setDocument({ ...document, contract: { ...object(document.contract), [key]: v } })} />)}</>
            : <ValueField name="contract" value={document.contract} onChange={v => setDocument({ ...document, contract: v })} />}<button className="secondary" onClick={() => setDocument({ ...document, contract: null })}>Убрать условия из черновика</button></>}
      </details>}
    </fieldset>
    <div className="row editor-actions"><button disabled={busy || contentInvalid || !dirty && !!entity.draft} onClick={() => void run('save')}>{busy ? 'Сохранение…' : 'Сохранить черновик'}</button>
      <button className="secondary" onClick={() => setPreview(v => !v)}>{preview ? 'Скрыть предпросмотр' : 'Предпросмотр'}</button>
      {role === 'OWNER' && <button className="secondary" disabled={busy || contentInvalid || dirty || !entity.draft} onClick={() => setConfirmPublish(v => !v)}>Опубликовать…</button>}
    </div>
    {confirmPublish && <div className="publication-confirm"><h3>Опубликовать сохранённый черновик {entity.draft?.revision}?</h3><p>Материал станет доступен публичному сайту. Статус продаж выездов не меняется.</p>
      {legal && <><label>Дата вступления в силу<input type="date" required min={new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date())} value={effectiveOn} onChange={e => setEffectiveOn(e.target.value)} /></label><label>Основание одобрения владельцем<textarea required maxLength={2000} value={approval} onChange={e => setApproval(e.target.value)} /></label><p className="muted">Публикация не подписывает поручение обработки данных и не выбирает условия для оплаты.</p></>}
      <button disabled={busy || legal && (!effectiveOn || !approval.trim())} onClick={() => void run('publish')}>Подтвердить публикацию</button>
    </div>}
    {preview && <article className="preview"><h3>Предпросмотр черновика</h3><p className="muted">Текстовый предпросмотр; изменения ещё не опубликованы.</p><DocumentPreview value={document} /></article>}
    <details className="history"><summary>Опубликованные версии ({entity.revisions.length})</summary>{entity.revisions.length === 0 ? <p>Публикаций ещё нет.</p> : entity.revisions.map(r => <details key={r.version}><summary>v{r.version} · {new Date(r.publishedAt).toLocaleString('ru-RU')} · {r.publishedBy}</summary>
      <p className="digest">{r.documentSha256}</p>{r.effectiveOn && <p>Действует с {r.effectiveOn} · {r.approval}</p>}{r.textSha256 && <p className="digest">Текст: {r.textSha256}</p>}<DocumentPreview value={r.document} /></details>)}</details>
  </section>;
}
function JsonSection({ label, value, onChange, onValidity }: { label: string; value: Document; onChange: (v: Document) => void; onValidity: (invalid: boolean) => void }) {
  const [raw, setRaw] = useState<string | null>(null); const [error, setError] = useState('');
  return <details><summary>{label}</summary><label>Объект JSON<textarea className="json-input" value={raw ?? JSON.stringify(value, null, 2)} onChange={e => { const text = e.target.value; setRaw(text); try { const v = JSON.parse(text); if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error(); onChange(v); onValidity(false); setError(''); setRaw(null); } catch { onValidity(true); setError('Введите корректный объект JSON. Сохранение заблокировано до исправления.'); } }} /></label>{error && <p className="error" role="alert">{error}</p>}</details>;
}
interface MediaAsset { id: string; state: string; alt: string; credit: string }
/** TOUR-63 owns upload/rights/publication. Editors reference only its approved assets. */
function MediaReferences({ kind, content, onChange }: { kind: string; content: Document; onChange: (v: Document) => void }) {
  const [assets, setAssets] = useState<MediaAsset[] | null>(null);
  const [error, setError] = useState('');
  const field = kind === 'organizer' ? 'photo' : kind === 'review' ? 'image' : 'coverImage';
  async function load() { setError(''); try { const r = await api<{ assets: MediaAsset[] }>('GET', '/media'); setAssets(r.assets.filter(a => a.state === 'PUBLISHED')); } catch { setError('Фототека недоступна. Подключение и загрузка фотографий требуют готового медиаэтапа.'); } }
  const selected = object(content[field]);
  return <details onToggle={e => { if (e.currentTarget.open && assets === null && !error) void load(); }}><summary>Фотографии</summary>
    <p className="muted">Используются только опубликованные фотографии из фототеки. Оригиналы и загрузка управляются в медиаэтапе Control Room.</p>
    {error ? <p role="status">{error} <button className="secondary" onClick={() => void load()}>Обновить фототеку</button></p> : assets === null ? <p>Загрузка фототеки…</p> : <>
      <label>{kind === 'organizer' ? 'Фото организатора' : kind === 'review' ? 'Фото отзыва' : 'Обложка'}<select value={String(selected.image ?? '')} onChange={e => {
        const asset = assets.find(a => `media:${a.id}` === e.target.value);
        onChange({ ...content, [field]: asset ? { image: `media:${asset.id}`, alt: asset.alt } : null });
      }}><option value="">Без фотографии</option>{selected.image && !assets.some(a => `media:${a.id}` === selected.image) && <option value={String(selected.image)}>Текущая ссылка · проверьте доступность</option>}{assets.map(a => <option key={a.id} value={`media:${a.id}`}>{a.alt} · {a.credit}</option>)}</select></label>
      {['tour','report'].includes(kind) && <fieldset className="nested"><legend>Галерея</legend>{assets.map(a => {
        const gallery = Array.isArray(content.gallery) ? content.gallery : [];
        const included = gallery.some(v => object(v).image === `media:${a.id}`);
        return <label className="checkbox" key={a.id}><input type="checkbox" checked={included} onChange={() => onChange({ ...content, gallery: included ? gallery.filter(v => object(v).image !== `media:${a.id}`) : [...gallery, { image: `media:${a.id}`, alt: a.alt }] })} />{a.alt}</label>;
      })}</fieldset>}
      {assets.length === 0 && <p className="muted">Опубликованных фотографий пока нет.</p>}
    </>}
  </details>;
}
function ValueField({ name, value, onChange, disabled = false }: { name: string; value: Value; onChange: (v: Value) => void; disabled?: boolean }) {
  const label = LABELS[name] ?? ({ contract: 'Условия', tour: 'Тур', departure: 'Выезд' }[name] ?? name);
  if (Array.isArray(value)) return <fieldset className="nested"><legend>{label}</legend>{value.map((v, i) => <div className="array-row" key={i}><ValueField name={name === 'program' || name === 'services' ? `${label} ${i + 1}` : name} value={v} onChange={next => onChange(value.map((old, n) => n === i ? next : old))} /><button type="button" className="secondary" aria-label={`Удалить ${label} ${i + 1}`} onClick={() => onChange(value.filter((_, n) => n !== i))}>Убрать</button></div>)}<button type="button" className="secondary" onClick={() => onChange([...value, arrayEntry(name)])}>Добавить · {label}</button></fieldset>;
  if (value !== null && typeof value === 'object') return <fieldset className="nested"><legend>{label}</legend><div className="field-grid">{Object.entries(value).map(([k, v]) => <ValueField key={k} name={k} value={v} onChange={next => onChange({ ...value, [k]: next })} />)}</div></fieldset>;
  if (typeof value === 'boolean') return <label className="checkbox"><input type="checkbox" checked={value} disabled={disabled} onChange={e => onChange(e.target.checked)} />{label}</label>;
  const numeric = typeof value === 'number' || name === 'priceKopecks';
  const type = numeric ? 'number' : /^(startsOn|endsOn|date|updatedAt)$/.test(name) ? 'date' : /^(departureTime|returnTime)$/.test(name) ? 'time' : 'text';
  const text = value === null ? '' : String(value);
  return <label>{label}{['body','description','summary','seoDescription','risks'].includes(name) ? <textarea value={text} disabled={disabled} onChange={e => onChange(e.target.value)} /> : <input type={type} value={text} disabled={disabled} step={numeric ? 1 : undefined} min={numeric ? 0 : undefined} onChange={e => onChange(e.target.value === '' && (numeric || value === null || ['insurance','tour','departure','date','category','registryNumber','vehicle','note'].includes(name)) ? null : numeric ? Number(e.target.value) : e.target.value)} />}</label>;
}
function DocumentPreview({ value }: { value: Value }) {
  if (value === null) return <span className="muted">Не задано</span>;
  if (Array.isArray(value)) return <ol>{value.map((v, i) => <li key={i}><DocumentPreview value={v} /></li>)}</ol>;
  if (typeof value === 'object') return <dl>{Object.entries(value).map(([key, v]) => <div key={key}><dt>{LABELS[key] ?? key}</dt><dd><DocumentPreview value={v} /></dd></div>)}</dl>;
  return <span className="preview-text">{typeof value === 'boolean' ? value ? 'Да' : 'Нет' : String(value)}</span>;
}

interface ControlDeparture { id: string; slug: string; bookingStatus: 'OPEN' | 'CLOSED' | 'CANCELLED'; capacity: number | null; isListed: boolean; controlVersion: number; takenSeats: number; cancellationRequestedAt: string | null }
interface Batch { id: string; createdAt: string; actor: string; closed: number }
function DepartureControls({ role, fail }: { role: Role; fail: Fail }) {
  const [rows, setRows] = useState<ControlDeparture[]>([]); const [batches, setBatches] = useState<Batch[]>([]); const [globalOpen, setGlobalOpen] = useState(false);
  const [busy, setBusy] = useState(false); const pending = useRef(false); const [message, setMessage] = useState(''); const [error, setError] = useState(''); const [pauseConfirm, setPauseConfirm] = useState(false);
  const load = useCallback(() => Promise.all([api<{ departures: ControlDeparture[] }>('GET', '/departures'), api<{ globalSalesOpen: boolean; batches: Batch[] }>('GET', '/departure-controls')]), []);
  const apply = useCallback(([d, c]: Awaited<ReturnType<typeof load>>) => { setRows(d.departures); setBatches(c.batches); setGlobalOpen(c.globalSalesOpen); }, []);
  useEffect(() => { let active = true; load().then(r => { if (active) apply(r); }, e => { if (active) { setError(messageFor(e)); failIfAuth(e, fail); } }); return () => { active = false; }; }, [load, apply, fail]);
  async function command(path: string, body: unknown) { if (pending.current) return; pending.current = true; setBusy(true); setError(''); setMessage(''); try {
    const r = await api<{ opened?: number; closed?: number; skipped?: unknown[] }>('POST', path, body);
    setMessage(r.closed !== undefined ? `Закрыто выездов: ${r.closed}.` : r.opened !== undefined ? `Открыто: ${r.opened}. Пропущено: ${r.skipped?.length ?? 0}.` : 'Изменение подтверждено.');
    await load().then(apply); setPauseConfirm(false);
  } catch (e) { setError(messageFor(e)); failIfAuth(e, fail); } finally { pending.current = false; setBusy(false); } }
  return <section className="operations"><h2>Управление выездами</h2><p className={globalOpen ? 'ok' : 'muted'}>Глобальный допуск: {globalOpen ? 'открыт оператором' : 'CLOSED — продажи остановлены оператором'}. Из Control Room его изменить нельзя.</p>
    {error && <p role="alert" className="error">{error} <button className="secondary" disabled={busy} onClick={() => void load().then(r => { apply(r); setError(''); }, fail)}>Обновить состояние</button></p>}{message && <p role="status" className="ok">{message}</p>}
    {role === 'OWNER' && <><button className="secondary" disabled={busy} onClick={() => setPauseConfirm(v => !v)}>Остановить все выезды…</button>{pauseConfirm && <div className="publication-confirm"><p>Все открытые выезды будут закрыты одной операцией. Заказы и оплаты не отменяются.</p><button disabled={busy} onClick={() => void command('/departure-controls/pause-all', {})}>Подтвердить остановку всех</button></div>}</>}
    <div className="control-list">{rows.map(d => <DepartureControlRow key={`${d.id}:${d.controlVersion}`} d={d} disabled={busy || role !== 'OWNER'} globalOpen={globalOpen} command={command} />)}</div>
    <details><summary>Операции массовой остановки</summary>{batches.length === 0 ? <p className="muted">Операций пока нет.</p> : batches.map(b => <div key={b.id} className="batch"><p>{new Date(b.createdAt).toLocaleString('ru-RU')} · {b.actor} · Закрыто: {b.closed}</p><p className="digest">{b.id}</p><button className="secondary" disabled={busy || !globalOpen || role !== 'OWNER'} onClick={() => void command(`/departure-controls/${b.id}/resume`, {})}>Восстановить подходящие выезды</button></div>)}</details>
  </section>;
}
function DepartureControlRow({ d, disabled, globalOpen, command }: { d: ControlDeparture; disabled: boolean; globalOpen: boolean; command: (path: string, body: unknown) => Promise<void> }) {
  const [capacity, setCapacity] = useState(String(d.capacity ?? ''));
  const apply = (body: object) => command(`/departures/${d.id}/controls`, { expectedVersion: d.controlVersion, ...body });
  return <fieldset disabled={disabled || d.bookingStatus === 'CANCELLED'} className="control-row"><legend>{d.slug} · {d.bookingStatus}</legend><p className="muted">Занято мест: {d.takenSeats}. {d.isListed ? 'Показан на сайте' : 'Скрыт с сайта'}.</p><div className="row">
    <button className="secondary" disabled={disabled || d.bookingStatus === 'CANCELLED' || d.bookingStatus === 'CLOSED' && (!globalOpen || !!d.cancellationRequestedAt)} onClick={() => void apply({ bookingStatus: d.bookingStatus === 'OPEN' ? 'CLOSED' : 'OPEN' })}>{d.bookingStatus === 'OPEN' ? 'Остановить выезд' : 'Возобновить выезд'}</button>
    <button className="secondary" onClick={() => void apply({ isListed: !d.isListed, ...(d.isListed && d.bookingStatus === 'OPEN' ? { bookingStatus: 'CLOSED' } : {}) })}>{d.isListed ? 'Закрыть и скрыть' : 'Показать на сайте'}</button>
    <label>Вместимость<input type="number" min={Math.max(1, d.takenSeats)} max={100000} step={1} value={capacity} onChange={e => setCapacity(e.target.value)} /></label><button className="secondary" disabled={!capacity || !Number.isSafeInteger(Number(capacity)) || Number(capacity) < Math.max(1, d.takenSeats)} onClick={() => void apply({ capacity: Number(capacity) })}>Сохранить вместимость</button>
  </div></fieldset>;
}
