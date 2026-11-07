import { useState } from 'preact/hooks';
import { api, type User } from './api.ts';

export function LoginPage({ onSuccess }: { onSuccess: (user: User) => void }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: Event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.login(login.trim(), password);
      setPassword('');
      onSuccess(result.user);
    } catch {
      setError('Those credentials were not accepted.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main class="login">
      <section class="login-card">
        <div class="brand brand-large">
          <span class="brand-mark" aria-hidden="true">
            360
          </span>
          <div>
            <h1>NiX 360 Media</h1>
            <p>Your private photo and video library</p>
          </div>
        </div>

        <form onSubmit={submit} class="stack">
          <label class="field">
            <span>Username</span>
            <input
              name="login"
              autocomplete="username"
              autocapitalize="none"
              spellcheck={false}
              value={login}
              required
              onInput={(event) => setLogin((event.target as HTMLInputElement).value)}
            />
          </label>
          <label class="field">
            <span>Password</span>
            <input
              name="password"
              type="password"
              autocomplete="current-password"
              value={password}
              required
              onInput={(event) => setPassword((event.target as HTMLInputElement).value)}
            />
          </label>
          {error ? (
            <p class="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <button class="button primary" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p class="muted small">Accounts are created by the household administrator. There is no public sign-up.</p>
      </section>
    </main>
  );
}
