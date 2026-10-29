import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import manifest from '../package.json';
import { extensionId, extensionVersion, userAgent } from '../src/user-agent';
import { Network } from '../src/network';

test('the extension id and version are read from the running manifest', () => {
  assert.equal(extensionId, `${manifest.publisher}.${manifest.name}`);
  assert.equal(extensionVersion(), manifest.version);
  assert.equal(userAgent(extensionVersion()), `MinecraftWorkbench/${manifest.version}`);
  assert.equal(userAgent(''), 'MinecraftWorkbench');
});
test('API and download requests send the manifest version as User-Agent', async () => {
  const seen: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers['user-agent']);
    res.writeHead(200, { 'content-length': 2 });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-agent-'));
  const network = new Network({
    proxy: '',
    sources: {},
    concurrency: 1,
    userAgent: userAgent(extensionVersion()),
  });
  try {
    assert.equal(network.userAgent, `MinecraftWorkbench/${manifest.version}`);
    await network.json(`${base}/api`);
    await network.download(`${base}/file`, path.join(root, 'file'));
    assert.deepEqual(seen, [
      `MinecraftWorkbench/${manifest.version}`,
      `MinecraftWorkbench/${manifest.version}`,
    ]);
  } finally {
    await network.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
