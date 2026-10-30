"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { EditorialWorkspace } from "@/components/editorial-workspace";

import { MediaPanel } from "./media-panel";

import { api, ApiError, messageFor, type SessionInfo } from "@/lib/api";

// The signed-in shell: the session (refresh, logout, other sessions), the editorial overview and,
// for the OWNER, the audit. All editors and operational controls use the same isolated API.

interface LiveSession { id: string; createdAt: string; lastSeenAt: string; idleExpiresAt: string; absoluteExpiresAt: string }
interface AuditEntry {
  id: number; at: string; actor: string; action: string; outcome: string; entityType: string | null; entityId: string | null;
  /** ATTESTED: written by the Admin API; FORGED: invalid MAC; UNVERIFIABLE: historical key unavailable; OPERATOR: an operator's or the owner's login. */
  evidence: "ATTESTED" | "FORGED" | "UNVERIFIABLE" | "OPERATOR";
}

type Tab = "media" | "sessions" | "tours" | "departures" | "content" | "audit";

const time = (iso: string) => new Date(iso).toLocaleString("ru-RU");
/** Refresh when less than this much idle time is left and the person is active. */
const REFRESH_BEFORE_MS = 10 * 60_000;

export default function Dashboard() {
  const router = useRouter();
  const [me, setMe] = useState<SessionInfo | null>(null);
  const [tab, setTab] = useState<Tab>("tours");
  const [unsaved, setUnsaved] = useState(false);
  const refreshing = useRef(false);
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
      if (refreshing.current) return;
      refreshing.current = true;
      api<SessionInfo>("POST", "/auth/refresh", {}).then(setMe, fail).finally(() => { refreshing.current = false; });
    };
    window.addEventListener("pointerdown", onActivity);
    window.addEventListener("keydown", onActivity);
    return () => {
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("keydown", onActivity);
    };
  }, [me, fail]);

  async function logout() {
    if (unsaved && !window.confirm("Есть несохранённые изменения. Выйти без сохранения?")) return;
    await api("POST", "/auth/logout", {}).catch(() => undefined);
    router.replace("/login/");
  }

  if (!me) return <p className="muted">{error ?? "Загрузка…"}</p>;
  const tabs: [Tab, string][] = [["sessions", "Сессии"], ["tours", "Туры"], ["departures", "Выезды"], ["content", "Материалы"], ["media", "Фото"]];
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
          <button key={key} className={tab === key ? undefined : "secondary"} aria-pressed={tab === key} onClick={() => {
            if (tab !== key && (!unsaved || window.confirm("Есть несохранённые изменения. Перейти без сохранения?"))) setTab(key);
          }}>{label}</button>
        ))}
      </nav>
      {tab === "sessions" && <Sessions me={me} onChange={setMe} fail={fail} />}
      {(tab === "tours" || tab === "departures" || tab === "content") && <EditorialWorkspace key={tab} collection={tab} role={me.role} fail={fail} onDirtyChange={setUnsaved} />}
      {tab === "media" && <MediaPanel role={me.role} fail={fail} />}
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
