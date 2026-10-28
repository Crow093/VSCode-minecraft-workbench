import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { Network } from '../src/network';
import { writeJson } from '../src/files';
import { resourceOf, sourceUrl } from '../src/sources';

test('resource routing keeps authentication and unsupported hosts official', () => {
  assert.equal(resourceOf('https://resources.download.minecraft.net/ab/abcd'), 'assets');
  assert.equal(
    sourceUrl('https://resources.download.minecraft.net/ab/abcd', { assets: 'bmclapi' }),
    'https://bmclapi2.bangbang93.com/assets/ab/abcd',
  );
  assert.equal(
    sourceUrl('https://api.minecraftservices.com/minecraft/profile', { loader: 'bmclapi' }),
    'https://api.minecraftservices.com/minecraft/profile',
  );
  assert.equal(
    sourceUrl('https://libraries.minecraft.net/a/b.jar', {
      libraries: 'https://mirror.test/maven',
    }),
    'https://mirror.test/maven/a/b.jar',
  );
  assert.throws(() =>
    sourceUrl('https://libraries.minecraft.net/a', { libraries: 'http://unsafe.test' }),
  );
});
test('download resumes, handles ignored ranges, follows redirects and validates hashes', async () => {
  const data = Buffer.from('minecraft-workbench-download-test'.repeat(1000));
  const sha1 = createHash('sha1').update(data).digest('hex');
  const seen: { route: string; range?: string }[] = [];
  const server = createServer((req, res) => {
    seen.push({ route: req.url!, range: req.headers.range });
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/file' });
      res.end();
      return;
    }
    const offset =
      req.headers.range && req.url !== '/ignore'
        ? Number(/bytes=(\d+)/.exec(req.headers.range)?.[1])
        : 0;
    if (offset >= data.length) {
      res.writeHead(416);
      res.end();
      return;
    }
    res.writeHead(offset ? 206 : 200, {
      etag: '"v1"',
      'content-length': data.length - offset,
      ...(offset ? { 'content-range': `bytes ${offset}-${data.length - 1}/${data.length}` } : {}),
    });
    if (req.url === '/slow') {
      let position = offset;
      const timer = setInterval(() => {
        res.write(data.subarray(position, position + 1000));
        position += 1000;
        if (position >= data.length) {
          clearInterval(timer);
          res.end();
        }
      }, 3);
      res.once('close', () => clearInterval(timer));
      return;
    }
    res.end(data.subarray(offset));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-net-'));
  const net = new Network({ proxy: '', sources: {}, concurrency: 2 });
  try {
    for (const route of ['/file', '/ignore', '/redirect']) {
      const target = path.join(root, route.slice(1));
      await fs.writeFile(target + '.part', data.subarray(0, 150));
      await writeJson(target + '.part.json', { url: base + route, etag: '"v1"' });
      await net.download(base + route, target, { hash: sha1, size: data.length });
      assert.deepEqual(await fs.readFile(target), data);
    }
    assert.ok(seen.some((req) => req.route === '/file' && req.range === 'bytes=150-'));
    const target = path.join(root, 'complete');
    await fs.writeFile(target + '.part', data);
    await writeJson(target + '.part.json', { url: base + '/file', etag: '"v1"' });
    await net.download(base + '/file', target, { hash: sha1 });
    assert.deepEqual(await fs.readFile(target), data);
    await assert.rejects(
      net.download(base + '/file', path.join(root, 'bad'), { hash: 'f'.repeat(40) }),
      /checksum/,
    );
    await assert.rejects(fs.access(path.join(root, 'bad')));
    await net.download(base + '/file', path.join(root, 'unknown-size'), { size: -1 });
    assert.deepEqual(await fs.readFile(path.join(root, 'unknown-size')), data);
    const interrupted = path.join(root, 'interrupted');
    const controller = new AbortController();
    await assert.rejects(
      net.download(base + '/slow', interrupted, {
        hash: sha1,
        signal: controller.signal,
        progress: (bytes) => {
          if (bytes > 5000) controller.abort();
        },
      }),
    );
    assert.ok((await fs.stat(interrupted + '.part')).size > 0);
    await net.download(base + '/slow', interrupted, { hash: sha1 });
    assert.deepEqual(await fs.readFile(interrupted), data);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      net.download(base + '/file', path.join(root, 'cancel'), { signal: abort.signal }),
    );
  } finally {
    await net.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
