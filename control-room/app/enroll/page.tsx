"use client";

import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { useState, type FormEvent } from "react";

import { api, messageFor, type SessionInfo } from "@/lib/api";

// Enrolment: available for 24 hours after an operator creates the account or resets its TOTP. The
// QR code is drawn here from the otpauth URI the Admin API returns; the first valid code confirms it
// and signs in. Nothing about the seed is kept in the browser after this page.
export default function EnrollPage() {
  const router = useRouter();
  const [credentials, setCredentials] = useState<{ login: string; password: string } | null>(null);
  const [qr, setQr] = useState<{ image: string; secret: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const login = String(form.get("login") ?? "");
    const password = String(form.get("password") ?? "");
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ secret: string; otpauthUri: string }>("POST", "/auth/enroll", { login, password });
      setQr({ image: await QRCode.toDataURL(r.otpauthUri, { errorCorrectionLevel: "M", margin: 2, width: 220 }), secret: r.secret });
      setCredentials({ login, password });
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!credentials) return;
    const code = new FormData(e.currentTarget).get("code");
    setBusy(true);
    setError(null);
    try {
      await api<SessionInfo>("POST", "/auth/enroll/confirm", { ...credentials, code });
      setCredentials(null);
      setQr(null);
      router.replace("/");
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h1>Подключение аутентификатора</h1>
      {!qr ? (
        <form onSubmit={start}>
          <p className="muted">Google Authenticator или совместимое приложение. Резервных кодов нет: при потере устройства
            оператор сбрасывает TOTP по SSH, после чего его нужно подключить заново.</p>
          <label>Логин <input name="login" autoComplete="username" required maxLength={64} /></label>
          <label>Пароль <input name="password" type="password" autoComplete="current-password" required maxLength={256} /></label>
          <button type="submit" disabled={busy}>Показать QR-код</button>
        </form>
      ) : (
        <form onSubmit={confirm}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="qr" src={qr.image} alt="QR-код для приложения-аутентификатора" />
          <p className="muted">Если QR-код не сканируется, введите ключ вручную (SHA-1, 6 цифр, 30 секунд):</p>
          <code className="secret">{qr.secret}</code>
          <label>Первый код из приложения
            <input name="code" inputMode="numeric" pattern="[0-9]{6}" autoComplete="one-time-code" required maxLength={6} />
          </label>
          <button type="submit" disabled={busy}>Подтвердить и войти</button>
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
