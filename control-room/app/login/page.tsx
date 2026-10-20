"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { api, ApiError, messageFor, type SessionInfo } from "@/lib/api";

// Password and a TOTP code at every login. There is no "remember me", no recovery code and no way
// to switch the second factor off here: a lost device is reset by an operator over SSH.
export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [needsEnrolment, setNeedsEnrolment] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api<SessionInfo>("POST", "/auth/login", {
        login: form.get("login"), password: form.get("password"), code: form.get("code"),
      });
      router.replace("/");
    } catch (err) {
      setNeedsEnrolment(err instanceof ApiError && err.code === "TOTP_ENROLLMENT_REQUIRED");
      setError(messageFor(err));
      (e.target as HTMLFormElement).querySelector<HTMLInputElement>("input[name=code]")!.value = "";
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h1>Вход</h1>
      <form onSubmit={submit}>
        <label>Логин <input name="login" autoComplete="username" required maxLength={64} /></label>
        <label>Пароль <input name="password" type="password" autoComplete="current-password" required maxLength={256} /></label>
        <label>Код из приложения-аутентификатора
          <input name="code" inputMode="numeric" pattern="[0-9]{6}" autoComplete="one-time-code" required maxLength={6} />
        </label>
        <button type="submit" disabled={busy}>Войти</button>
        {error && <p className="error" role="alert">{error}</p>}
        {needsEnrolment && <p><a href="/enroll/">Подключить аутентификатор</a></p>}
      </form>
    </div>
  );
}
