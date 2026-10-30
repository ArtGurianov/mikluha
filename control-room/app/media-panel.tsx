"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, type Role } from "@/lib/api";

interface Asset {
  id: string;
  alt: string;
  credit: string;
  state: string;
  rights_basis: string;
  rights_reference: string;
  attempts: number;
  last_error: string | null;
  variants: { url: string; width: number }[];
}
const STATES: Record<string, string> = {
  UPLOADED: "Обработка",
  READY: "Готово к публикации",
  PUBLISH_REQUESTED: "Публикуется",
  PUBLISHED: "Опубликовано",
  REVOKE_REQUESTED: "Отзыв: удаление не подтверждено",
  REVOKED: "Удаление подтверждено",
  REJECTED: "Изображение отклонено",
};

export function MediaPanel({ role, fail }: { role: Role; fail: (e: unknown) => void }) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  // Keep an upload ID after a network error: retry cannot create a duplicate. Editing resets it.
  const attempt = useRef<string | null>(null);
  const refresh = useCallback(
    () => api<{ assets: Asset[] }>("GET", "/media").then((r) => setAssets(r.assets), fail),
    [fail],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const file = data.get("image");
    if (!(file instanceof File) || !file.size || file.size > 8 * 1024 * 1024) {
      setNotice("Выберите JPEG, PNG или WebP размером до 8 МиБ.");
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      const encoded = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("FILE_READ"));
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.readAsDataURL(file);
      });
      attempt.current ??= crypto.randomUUID();
      await api("POST", "/media", {
        id: attempt.current,
        data: encoded,
        alt: data.get("alt"),
        credit: data.get("credit"),
        rightsBasis: data.get("basis"),
        rightsReference: data.get("reference"),
        rightsConfirmed: data.get("confirmed") === "on",
      });
      form.reset();
      attempt.current = null;
      setNotice("Фото принято. После обработки владелец сможет его опубликовать.");
      await refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function command(id: string, action: "publish" | "revoke") {
    if (
      action === "revoke" &&
      !window.confirm(
        "Отозвать фото и удалить оригинал и варианты из хранилища? Уже скачанные копии вернуть невозможно.",
      )
    )
      return;
    setBusy(true);
    try {
      await api("POST", `/media/${id}/${action}`, {});
      await refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="media-title">
      <div className="row">
        <h2 id="media-title">Фотографии</h2>
        <button className="secondary" disabled={busy} onClick={() => void refresh()}>
          Обновить статусы
        </button>
      </div>
      <p className="muted">Оригинал закрыт. Публичные варианты появляются только после решения владельца.</p>
      <form
        onSubmit={upload}
        onChange={() => {
          attempt.current = null;
        }}
      >
        <fieldset className="media-fields" disabled={busy}>
          <legend>Новое фото</legend>
          <label>
            Файл · до 8 МиБ
            <input name="image" type="file" accept="image/jpeg,image/png,image/webp" required />
          </label>
          <label>
            Описание для читателя
            <input name="alt" maxLength={500} required />
          </label>
          <label>
            Автор / подпись
            <input name="credit" maxLength={500} required />
          </label>
          <label>
            Основание публикации
            <select name="basis" required>
              <option value="OWNED">Собственные права</option>
              <option value="CONSENT">Согласие на публикацию</option>
            </select>
          </label>
          <label>
            Документ / запись о правах
            <input name="reference" maxLength={1000} required />
          </label>
          <label className="check">
            <input name="confirmed" type="checkbox" required />
            Права на фото и согласия всех узнаваемых людей проверены; ссылка выше подтверждает основания
            публикации.
          </label>
          <button type="submit">Загрузить для обработки</button>
        </fieldset>
      </form>
      {notice && <p role="status">{notice}</p>}
      <ul className="media-list">
        {assets.map((a) => (
          <li key={a.id}>
            <h3>{a.alt}</h3>
            <p>
              {a.credit} · {STATES[a.state] ?? a.state}
            </p>
            <p className="muted">
              Основание: {a.rights_basis === "OWNED" ? "собственные права" : "согласие"} ·{" "}
              {a.rights_reference}
            </p>
            <p>
              Ссылка для редактора: <code>media:{a.id}</code>
            </p>
            {a.last_error && (
              <p role="status">
                {a.last_error === "PRIVACY_UNCONFIRMED"
                  ? "Закрытый доступ не подтверждён. Фото изолировано, удаление проверяется. "
                  : "Хранилище пока не подтвердило действие. "}
                Попыток: {a.attempts}/5. После пяти попыток требуется оператор.
              </p>
            )}
            {a.state === "PUBLISHED" &&
              a.variants.map((v) => (
                <p key={v.width}>
                  <a href={v.url} target="_blank" rel="noreferrer">
                    Открыть вариант {v.width} px
                  </a>
                </p>
              ))}
            {role === "OWNER" && (
              <div className="row">
                {a.state === "READY" && (
                  <button disabled={busy} onClick={() => void command(a.id, "publish")}>
                    Опубликовать
                  </button>
                )}
                {!["REVOKED", "REVOKE_REQUESTED"].includes(a.state) && (
                  <button className="secondary" disabled={busy} onClick={() => void command(a.id, "revoke")}>
                    Отозвать и удалить
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
