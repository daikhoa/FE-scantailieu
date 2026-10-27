import { useState, type SyntheticEvent } from 'react';
import './account.css';

export type AuthMode = 'login' | 'register';

export function AuthScreen({
  onAuthenticate,
}: {
  readonly onAuthenticate: (mode: AuthMode, email: string, password: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (mode === 'register' && password !== confirmation) {
      setError('Mật khẩu nhập lại chưa khớp.');
      return;
    }
    setBusy(true);
    try {
      await onAuthenticate(mode, email.trim(), password);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Không thể đăng nhập. Vui lòng thử lại.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main id="main-content" className="account-screen" aria-label="clonecamscanner">
      <section className="account-card" aria-labelledby="auth-title">
        <p className="eyebrow">clonecamscanner</p>
        <h1 id="auth-title">
          {mode === 'login' ? 'Tài liệu của bạn, luôn sẵn sàng' : 'Tạo không gian tài liệu của bạn'}
        </h1>
        <p className="account-intro">
          Đăng nhập để quét, lưu và tiếp tục chỉnh sửa tài liệu trên các thiết bị.
        </p>
        <div className="account-tabs" role="group" aria-label="Chọn đăng nhập hoặc đăng ký">
          <button
            type="button"
            aria-pressed={mode === 'login'}
            disabled={busy}
            onClick={() => {
              setMode('login');
              setError('');
            }}
          >
            Đăng nhập
          </button>
          <button
            type="button"
            aria-pressed={mode === 'register'}
            disabled={busy}
            onClick={() => {
              setMode('register');
              setError('');
            }}
          >
            Tạo tài khoản
          </button>
        </div>
        <form
          aria-label={mode === 'login' ? 'Đăng nhập tài khoản' : 'Đăng ký tài khoản'}
          onSubmit={(event) => void submit(event)}
        >
          <label htmlFor="account-email">Email</label>
          <input
            id="account-email"
            type="email"
            autoComplete="email"
            inputMode="email"
            maxLength={254}
            required
            value={email}
            disabled={busy}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
          <label htmlFor="account-password">Mật khẩu</label>
          <input
            id="account-password"
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            minLength={10}
            maxLength={128}
            required
            value={password}
            disabled={busy}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
            aria-describedby="password-help"
          />
          <small id="password-help">Từ 10 đến 128 ký tự.</small>
          {mode === 'register' && (
            <>
              <label htmlFor="account-confirm">Nhập lại mật khẩu</label>
              <input
                id="account-confirm"
                type="password"
                autoComplete="new-password"
                required
                value={confirmation}
                disabled={busy}
                onChange={(event) => {
                  setConfirmation(event.target.value);
                }}
              />
            </>
          )}
          {error && (
            <p className="editor__error" role="alert">
              {error}
            </p>
          )}
          <button className="primary-button" type="submit" disabled={busy} aria-busy={busy}>
            {busy ? 'Đang kết nối…' : mode === 'login' ? 'Vào kho tài liệu' : 'Đăng ký và bắt đầu'}
          </button>
        </form>
      </section>
    </main>
  );
}
