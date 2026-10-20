"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { api, ApiError, messageFor, type SessionInfo } from "@/lib/api";

// The signed-in shell: the session (refresh, logout, other sessions), the editorial overview and,
// for the OWNER, the audit. Editors for tours and departures come with ART-365 on the same API.

interface LiveSession { id: string; createdAt: string; lastSeenAt: string; idleExpiresAt: string; absoluteExpiresAt: string }
interface Tour { id: string; slug: string; title: string | null; publishedVersion: number | null; draftRevision: number | null }
interface Departure {
  id: string; slug: string; startsOn: string | null; endsOn: string | null; priceKopecks: number | null;
  bookingStatus: string; isListed: boolean; publishedVersion: number | null; draftRevision: number | null;
}
interface AuditEntry {
  id: number; at: string; actor: string; action: string; outcome: string; entityType: string | null; entityId: string | null;
  /** ATTESTED: written by the Admin API; FORGED: invalid MAC; UNVERIFIABLE: historical key unavailable; OPERATOR: an operator's or the owner's login. */
  evidence: "ATTESTED" | "FORGED" | "UNVERIFIABLE" | "OPERATOR";
}

type Tab = "sessions" | "tours" | "departures" | "audit";

const time = (iso: string) => new Date(iso).toLocaleString("ru-RU");
const rub = (k: number | null) => (k === null ? "—" : `${(k / 100).toLocaleString("ru-RU")} ₽`);
/** Refresh when less than this much idle time is left and the person is active. */
const REFRESH_BEFORE_MS = 10 * 60_000;

export default function Dashboard() {
  const router = useRouter();
  const [me, setMe] = useState<SessionInfo | null>(null);
  const [tab, setTab] = useState<Tab>("sessions");
  const [error, setError] = useState<string | null>(null);

  const fail = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 401) { router.replace("/login/"); return; }
    setError(messageFor(err));
  }, [router]);

  useEffect(() => { api<SessionInfo>("GET", "/auth/session").then(setMe, fail); }, [fail]);

  // Activity keeps the session alive by rotating its token before the idle limit; it never extends
  // the 12-hour maximum.
  useEffect(() => {
    if (!me) return;
    const onActivity = () => {
      if (new Date(me.idleExpiresAt).getTime() - Date.now() > REFRESH_BEFORE_MS) return;
      api<SessionInfo>("POST", "/auth/refresh", {}).then(setMe, fail);
    };
    window.addEventListener("pointerdown", onActivity);
    window.addEventListener("keydown", onActivity);
    return () => {
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("keydown", onActivity);
    };
  }, [me, fail]);

  async function logout() {
    await api("POST", "/auth/logout", {}).catch(() => undefined);
    router.replace("/login/");
  }

  if (!me) return <p className="muted">{error ?? "Загрузка…"}</p>;
  const tabs: [Tab, string][] = [["sessions", "Сессии"], ["tours", "Туры"], ["departures", "Выезды"]];
  if (me.role === "OWNER") tabs.push(["audit", "Аудит"]);

  return (
    <>
      <div className="row">
        <h1>Control Room</h1>
        <span className="muted">{me.login} · {me.role === "OWNER" ? "владелец" : "редактор"}</span>
        <button className="secondary" onClick={logout}>Выйти</button>
      </div>
      <p className="muted">Сессия до {time(me.idleExpiresAt)} без активности, не позже {time(me.absoluteExpiresAt)}.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <nav className="tabs">
        {tabs.map(([key, label]) => (
          <button key={key} className={tab === key ? undefined : "secondary"} aria-pressed={tab === key} onClick={() => setTab(key)}>{label}</button>
        ))}
      </nav>
      {tab === "sessions" && <Sessions me={me} onChange={setMe} fail={fail} />}
      {tab === "tours" && <Tours fail={fail} />}
      {tab === "departures" && <Departures fail={fail} />}
      {tab === "audit" && <Audit fail={fail} />}
    </>
  );
}

function Sessions({ me, onChange, fail }: { me: SessionInfo; onChange: (s: SessionInfo) => void; fail: (e: unknown) => void }) {
  const [list, setList] = useState<LiveSession[]>([]);
  const load = useCallback(() => {
    api<{ sessions: LiveSession[] }>("GET", "/auth/sessions").then(r => setList(r.sessions), fail);
  }, [fail]);
  useEffect(load, [load, me.sessionId]);

  return (
    <div className="card">
      <div className="row">
        <h2>Активные сессии</h2>
        <button className="secondary" onClick={() => api<SessionInfo>("POST", "/auth/refresh", {}).then(onChange, fail)}>Продлить</button>
      </div>
      <table>
        <thead><tr><th>Начата</th><th>Активность</th><th>Истекает</th><th /></tr></thead>
        <tbody>
          {list.map(s => (
            <tr key={s.id}>
              <td>{time(s.createdAt)}</td>
              <td>{time(s.lastSeenAt)}</td>
              <td>{time(s.idleExpiresAt)}</td>
              <td>{s.id === me.sessionId ? <span className="ok">эта</span> : (
                <button className="secondary" onClick={() => api("POST", "/auth/sessions/revoke", { sessionId: s.id }).then(load, fail)}>Завершить</button>
              )}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Tours({ fail }: { fail: (e: unknown) => void }) {
  const [tours, setTours] = useState<Tour[] | null>(null);
  useEffect(() => { api<{ tours: Tour[] }>("GET", "/tours").then(r => setTours(r.tours), fail); }, [fail]);
  if (!tours) return <p className="muted">Загрузка…</p>;
  return (
    <div className="card">
      <table>
        <thead><tr><th>Slug</th><th>Название</th><th>Опубликовано</th><th>Черновик</th></tr></thead>
        <tbody>
          {tours.map(t => (
            <tr key={t.id}><td>{t.slug}</td><td>{t.title ?? "—"}</td><td>{t.publishedVersion ? `v${t.publishedVersion}` : "нет"}</td><td>{t.draftRevision ?? "—"}</td></tr>
          ))}
        </tbody>
      </table>
      {tours.length === 0 && <p className="muted">Туров пока нет.</p>}
    </div>
  );
}

function Departures({ fail }: { fail: (e: unknown) => void }) {
  const [list, setList] = useState<Departure[] | null>(null);
  useEffect(() => { api<{ departures: Departure[] }>("GET", "/departures").then(r => setList(r.departures), fail); }, [fail]);
  if (!list) return <p className="muted">Загрузка…</p>;
  return (
    <div className="card">
      <table>
        <thead><tr><th>Slug</th><th>Даты</th><th>Цена</th><th>Продажи</th><th>Опубликовано</th></tr></thead>
        <tbody>
          {list.map(d => (
            <tr key={d.id}>
              <td>{d.slug}</td>
              <td>{d.startsOn ? `${d.startsOn} — ${d.endsOn}` : "—"}</td>
              <td>{rub(d.priceKopecks)}</td>
              <td>{d.bookingStatus}{d.isListed ? "" : " · скрыт"}</td>
              <td>{d.publishedVersion ? `v${d.publishedVersion}` : "нет"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.length === 0 && <p className="muted">Выездов пока нет.</p>}
    </div>
  );
}

function Audit({ fail }: { fail: (e: unknown) => void }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  useEffect(() => { api<{ entries: AuditEntry[] }>("GET", "/audit").then(r => setEntries(r.entries), fail); }, [fail]);
  if (!entries) return <p className="muted">Загрузка…</p>;
  return (
    <div className="card">
      <table>
        <thead><tr><th>Время</th><th>Кто</th><th>Действие</th><th>Итог</th><th>Объект</th><th>Подлинность</th></tr></thead>
        <tbody>
          {entries.map(e => (
            <tr key={e.id}>
              <td>{time(e.at)}</td><td>{e.actor}</td><td>{e.action}</td>
              <td className={e.outcome === "OK" ? "ok" : "error"}>{e.outcome}</td>
              <td>{e.entityType ? `${e.entityType} ${e.entityId ?? ""}` : "—"}</td>
              <td className={(e.evidence === "FORGED" || e.evidence === "UNVERIFIABLE") ? "error" : undefined}>
                {e.evidence === "ATTESTED" ? "Admin API" : e.evidence === "OPERATOR" ? "оператор" : e.evidence === "UNVERIFIABLE" ? "КЛЮЧ НЕДОСТУПЕН" : "НЕ ПОДТВЕРЖДЕНО"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
