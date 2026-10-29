export type ProxyProblem = 'invalid' | 'unsupported';

export interface ProxyResolution {
  proxy: string;
  problem?: ProxyProblem;
}

const schemes = ['http:', 'https:', 'socks:', 'socks5:', 'socks5h:'];

function parseCredentials(value: unknown): { username: string; password: string } | undefined {
  let source = value;
  if (typeof source === 'string') {
    if (!source.trim()) return undefined;
    try {
      source = JSON.parse(source);
    } catch {
      return undefined;
    }
  }
  if (!source || typeof source !== 'object') return undefined;
  const record = source as Record<string, unknown>;
  const username = typeof record.username === 'string' ? record.username : '';
  const password = typeof record.password === 'string' ? record.password : '';
  if (!username && !password) return undefined;
  return { username, password };
}

/**
 * Turns the configured proxy plus the stored credentials into the URL handed to
 * the network layer. Invalid input is reported instead of thrown so that a bad
 * `http.proxy` value can never stop the extension from activating.
 */
export function resolveProxy(raw: unknown, credentials?: unknown): ProxyResolution {
  const proxy = typeof raw === 'string' ? raw.trim() : '';
  if (!proxy) return { proxy: '' };
  let url: URL;
  try {
    url = new URL(proxy);
  } catch {
    return { proxy: '', problem: 'invalid' };
  }
  if (!schemes.includes(url.protocol)) return { proxy: '', problem: 'unsupported' };
  const value = parseCredentials(credentials);
  if (!value) return { proxy };
  url.username = value.username;
  url.password = value.password;
  const serialized = url.toString();
  // `URL` adds an implicit trailing slash to http(s) URLs. Drop it again so the
  // value keeps the shape the user typed instead of differing from the
  // credential-less branch for no functional reason.
  const trimmed =
    url.pathname === '/' && !url.search && !url.hash && !proxy.endsWith('/')
      ? serialized.replace(/\/$/, '')
      : serialized;
  return { proxy: trimmed };
}
