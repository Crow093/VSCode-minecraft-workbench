import { Agent, Dispatcher, ProxyAgent, request, interceptors } from 'undici';
import { SocksClient } from 'socks';
import * as tls from 'node:tls';
import * as dns from 'node:dns/promises';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { exists, hashFile, readJson, writeJson } from './files';
import { Resource, sourceUrl } from './sources';

export interface NetworkOptions {
  proxy: string;
  sources: Partial<Record<Resource, string>>;
  concurrency: number;
  retries?: number;
  timeout?: number;
}
interface JsonOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  form?: URLSearchParams;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  kind?: Resource;
}
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}`);
  }
}
export class Network {
  readonly dispatcher: Dispatcher;
  constructor(readonly options: NetworkOptions) {
    if (/^socks/.test(options.proxy)) {
      const proxy = new URL(options.proxy);
      if (!['socks:', 'socks5:', 'socks5h:'].includes(proxy.protocol))
        throw new Error('Use SOCKS5 or SOCKS5h');
      this.dispatcher = new Agent({
        connect: (opts, callback) => {
          void (async () => {
            let host = opts.hostname;
            if (proxy.protocol === 'socks5:') host = (await dns.lookup(host)).address;
            const connection = await SocksClient.createConnection({
              proxy: {
                host: proxy.hostname,
                port: Number(proxy.port || 1080),
                type: 5,
                userId: decodeURIComponent(proxy.username),
                password: decodeURIComponent(proxy.password),
              },
              command: 'connect',
              destination: {
                host,
                port: Number(opts.port || (opts.protocol === 'https:' ? 443 : 80)),
              },
              timeout: options.timeout || 30000,
            });
            if (opts.protocol === 'https:') {
              const socket = tls.connect({ socket: connection.socket, servername: opts.hostname });
              const error = (e: Error) => callback(e, null);
              socket.once('error', error);
              socket.once('secureConnect', () => {
                socket.off('error', error);
                callback(null, socket);
              });
            } else callback(null, connection.socket);
          })().catch((error) => callback(error, null));
        },
      });
    } else
      this.dispatcher = options.proxy
        ? new ProxyAgent(options.proxy)
        : new Agent({
            connections: options.concurrency,
            connect: { timeout: options.timeout || 30000 },
          });
    this.dispatcher = this.dispatcher.compose(interceptors.redirect({ maxRedirections: 8 }));
  }
  async close() {
    await this.dispatcher.close();
  }
  async json<T>(url: string, options: JsonOptions = {}): Promise<T> {
    return JSON.parse(await this.text(url, options)) as T;
  }
  async text(url: string, options: JsonOptions = {}): Promise<string> {
    const target =
      options.method === 'POST' || options.headers?.Authorization
        ? url
        : sourceUrl(url, this.options.sources, options.kind);
    const execute = async (uri: string) => {
      const response = await request(uri, {
        dispatcher: this.dispatcher,
        method: options.method || 'GET',
        headers: {
          'user-agent': 'MinecraftWorkbench/0.3.1',
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...(options.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...options.headers,
        },
        body: options.form?.toString() ?? (options.body ? JSON.stringify(options.body) : undefined),
        signal: options.signal,
        headersTimeout: this.options.timeout || 30000,
        bodyTimeout: (this.options.timeout || 30000) * 2,
      });
      const body = await response.body.text();
      if (response.statusCode >= 400) throw new HttpError(response.statusCode, body);
      return body;
    };
    try {
      return await execute(target);
    } catch (error) {
      if (target !== url && !options.signal?.aborted) return execute(url);
      throw error;
    }
  }
  async download(
    url: string,
    destination: string,
    options: {
      hash?: string;
      algorithm?: string;
      size?: number;
      kind?: Resource;
      signal?: AbortSignal;
      progress?: (bytes: number, total: number) => void;
    } = {},
  ): Promise<void> {
    if (options.size !== undefined && options.size < 0) options = { ...options, size: undefined };
    const valid = async (file: string) =>
      (await exists(file)) &&
      (!options.size || (await fs.stat(file)).size === options.size) &&
      (!options.hash || (await hashFile(file, options.algorithm)) === options.hash);
    if ((await valid(destination)) && (options.hash || options.size)) return;
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const part = destination + '.part';
    const meta = part + '.json';
    const target = sourceUrl(url, this.options.sources, options.kind);
    const attempts = Math.max(1, Math.min(9, (this.options.retries ?? 2) + 1));
    for (let attempt = 0; attempt < attempts; attempt++) {
      options.signal?.throwIfAborted();
      const uri = attempt === attempts - 1 ? url : target;
      try {
        const previous = await readJson<{ url: string; etag?: string }>(meta, { url: '' });
        let offset = (await exists(part)) && previous.url === uri ? (await fs.stat(part)).size : 0;
        if (!options.hash && !previous.etag) offset = 0;
        const response = await request(uri, {
          dispatcher: this.dispatcher,
          signal: options.signal,
          headers: {
            'user-agent': 'MinecraftWorkbench/0.3.1',
            ...(offset
              ? {
                  Range: `bytes=${offset}-`,
                  ...(previous.etag ? { 'If-Range': previous.etag } : {}),
                }
              : {}),
          },
          headersTimeout: this.options.timeout || 30000,
          bodyTimeout: (this.options.timeout || 30000) * 2,
        });
        if (response.statusCode === 416) {
          await response.body.dump();
          if ((await valid(part)) && (options.hash || options.size)) {
            await fs.rename(part, destination);
            await fs.rm(meta, { force: true });
            return;
          }
          await fs.rm(part, { force: true });
          throw new Error('Invalid range; restarting download');
        }
        if (response.statusCode >= 400) {
          await response.body.dump();
          throw new HttpError(response.statusCode, 'Download failed');
        }
        if (response.statusCode === 206) {
          const range = String(response.headers['content-range'] || '');
          if (!range.startsWith(`bytes ${offset}-`)) {
            await response.body.dump();
            await fs.rm(part, { force: true });
            throw new Error('Invalid Content-Range');
          }
        } else offset = 0;
        const total = offset + Number(response.headers['content-length'] || 0);
        await writeJson(meta, { url: uri, etag: response.headers.etag });
        let bytes = offset;
        response.body.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          options.progress?.(bytes, total);
        });
        await pipeline(response.body, createWriteStream(part, { flags: offset ? 'a' : 'w' }), {
          signal: options.signal,
        });
        if (!(await valid(part))) {
          const actualSize = (await fs.stat(part)).size;
          const actualHash = options.hash ? await hashFile(part, options.algorithm) : '';
          await fs.rm(part, { force: true });
          throw new Error(
            `Download checksum or size mismatch: ${path.basename(destination)} (${actualSize}/${options.size ?? '?'} bytes; ${actualHash}/${options.hash ?? '?'})`,
          );
        }
        await fs.rename(part, destination);
        await fs.rm(meta, { force: true });
        return;
      } catch (error) {
        if (options.signal?.aborted || attempt === attempts - 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  }
}
