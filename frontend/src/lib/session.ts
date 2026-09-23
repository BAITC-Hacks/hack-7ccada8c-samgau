const KEY = 'qor-bearer-session';
let pending: Promise<string> | null = null;
export function resetSession() {
  for (const key of Object.keys(sessionStorage))
    if (key.startsWith('qor-')) sessionStorage.removeItem(key);
  pending = null;
}
export function sessionToken(create: () => Promise<{ token: string }>) {
  const saved = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(KEY);
  if (saved) return Promise.resolve(saved);
  if (!pending)
    pending = create()
      .then(({ token }) => {
        if (!token) throw new Error('Сервер не создал сессию.');
        if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(KEY, token);
        return token;
      })
      .finally(() => {
        pending = null;
      });
  return pending;
}
