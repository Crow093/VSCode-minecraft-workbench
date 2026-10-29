import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { ContentService } from '../src/content';
import { Network, HttpError } from '../src/network';
import { Instance, ModVersion } from '../src/models';
import { writeJson } from '../src/files';

const payload = Buffer.from('test-mod');
function version(id: string, project = id): ModVersion {
  return {
    id,
    project_id: project,
    name: id,
    version_number: id,
    game_versions: ['1.21.1'],
    loaders: ['fabric'],
    dependencies: [],
    files: [
      {
        url: `https://cdn.modrinth.com/${id}.jar`,
        filename: `${id}.jar`,
        primary: true,
        size: payload.length,
        hashes: { sha1: createHash('sha1').update(payload).digest('hex') },
      },
    ],
  };
}
test('required dependencies install once; updates retain disabled state and archive old files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-content-'));
  const instance: Instance = {
    id: 'test',
    name: 'Test',
    directory: root,
    minecraft: '1.21.1',
    loader: 'fabric',
    createdAt: '',
  };
  const dep = version('dependency');
  const mod = version('mod-v1', 'mod');
  mod.dependencies.push({
    project_id: 'dependency',
    version_id: dep.id,
    dependency_type: 'required',
  });
  let downloads = 0;
  const net = {
    json: async (url: string) => {
      if (url.includes('/version/dependency')) return dep;
      if (url.includes('/version/mod-v1')) return mod;
      throw new Error(url);
    },
    download: async (_url: string, target: string) => {
      downloads++;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, payload);
    },
  } as unknown as Network;
  const service = new ContentService(net);
  try {
    await service.install(instance, mod, 'mod', new AbortController().signal, () => {});
    assert.equal(downloads, 2);
    assert.equal((await service.list(instance)).length, 2);
    const old = (await service.list(instance)).find((i) => i.projectId === 'mod')!;
    await service.toggle(instance, old);
    const update = version('mod-v2', 'mod');
    await service.install(instance, update, 'mod', new AbortController().signal, () => {});
    const current = (await service.list(instance)).find((i) => i.projectId === 'mod')!;
    assert.equal(current.enabled, false);
    assert.equal(current.file, 'mod-v2.jar.disabled');
    await assert.rejects(fs.access(path.join(root, 'mods', 'mod-v1.jar.disabled')));
    assert.ok((await fs.readdir(path.join(root, '.workbench', 'history'))).length > 0);
    const conflict = version('conflict');
    conflict.dependencies.push({ project_id: 'dependency', dependency_type: 'incompatible' });
    await assert.rejects(
      service.install(instance, conflict, 'mod', new AbortController().signal, () => {}),
      /Incompatible/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('modpack paths cannot escape an instance and server-only files are skipped', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-pack-'));
  const instance: Instance = {
    id: 'test',
    name: 'Test',
    directory: path.join(root, 'instance'),
    minecraft: '',
    loader: 'vanilla',
    createdAt: '',
  };
  const net = {
    download: async () => {
      throw new Error('Unexpected download');
    },
  } as unknown as Network;
  const service = new ContentService(net);
  const index = {
    formatVersion: 1,
    game: 'minecraft',
    dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.0' },
    files: [
      {
        path: '../outside.jar',
        hashes: { sha1: 'abc' },
        downloads: ['https://example.com/test.jar'],
        fileSize: 10,
      },
    ],
  };
  const archive = path.join(root, 'pack.mrpack');
  try {
    const zip = new AdmZip();
    zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify(index)));
    zip.writeZip(archive);
    await assert.rejects(
      service.importPack(archive, instance, new AbortController().signal, () => {}),
      /Reserved|escapes/,
    );
    index.files = [];
    const safe = new AdmZip();
    safe.addFile('modrinth.index.json', Buffer.from(JSON.stringify(index)));
    safe.addFile('overrides/config/test.json', Buffer.from('{}'));
    safe.writeZip(archive);
    await service.importPack(archive, instance, new AbortController().signal, () => {});
    assert.equal(instance.loader, 'fabric');
    assert.equal(instance.minecraft, '1.21.1');
    assert.equal(
      await fs.readFile(path.join(instance.directory, 'config', 'test.json'), 'utf8'),
      '{}',
    );
    await writeJson(path.join(root, 'keep.json'), { safe: true });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('conflicts fetch online metadata once per version and reuse it across checks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-conflicts-'));
  const instance: Instance = {
    id: 'test',
    name: 'Test',
    directory: root,
    minecraft: '1.21.1',
    loader: 'fabric',
    loaderVersion: '0.16.0',
    createdAt: '',
  };
  const installed = {
    file: 'a.jar',
    kind: 'mod' as const,
    name: 'A',
    projectId: 'mod-a',
    versionId: 'a-v1',
    hash: 'hash',
    enabled: true,
  };
  const other = { ...installed, file: 'b.jar', name: 'B', projectId: 'mod-b', versionId: 'b-v1' };
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const net = {
    json: async (url: string) => {
      calls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      if (url.endsWith('/version/a-v1')) return version('a-v1', 'mod-a');
      const missing = version('b-v1', 'mod-b');
      missing.dependencies.push({ project_id: 'absent', dependency_type: 'required' });
      return missing;
    },
  } as unknown as Network;
  const service = new ContentService(net);
  try {
    await fs.mkdir(path.join(root, 'mods'), { recursive: true });
    for (const name of ['a.jar', 'b.jar']) {
      const zip = new AdmZip();
      zip.addFile('pack.mcmeta', Buffer.from('{}'));
      zip.writeZip(path.join(root, 'mods', name));
    }
    await writeJson(path.join(root, '.workbench', 'content.json'), [installed, other]);
    assert.deepEqual(await service.conflicts(instance), ['B: required absent']);
    assert.equal(calls, 2);
    assert.equal(maxInFlight, 2);
    assert.deepEqual(await service.conflicts(instance), ['B: required absent']);
    assert.equal(calls, 2);
    const offline = new ContentService({
      json: async () => {
        throw new Error('offline');
      },
    } as unknown as Network);
    assert.deepEqual(await offline.conflicts(instance), [
      'Online metadata unavailable; local checks only.',
    ]);
    const missing = new ContentService({
      json: async () => {
        throw new HttpError(404, 'missing');
      },
    } as unknown as Network);
    assert.deepEqual(await missing.conflicts(instance), ['A: HTTP 404', 'B: HTTP 404']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('conflict warnings keep the per-mod local-then-online order', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-conflict-order-'));
  const instance: Instance = {
    id: 'test',
    name: 'Test',
    directory: root,
    minecraft: '1.21.1',
    loader: 'fabric',
    loaderVersion: '0.16.0',
    createdAt: '',
  };
  const entries = ['a.jar', 'b.jar'].map((file) => ({
    file,
    kind: 'mod' as const,
    name: file[0].toUpperCase(),
    projectId: `mod-${file[0]}`,
    versionId: `${file[0]}-v1`,
    hash: 'hash',
    enabled: true,
  }));
  const net = {
    json: async (url: string) => {
      const broken = version(url.split('/').pop()!, 'mod-x');
      broken.dependencies.push({ project_id: 'absent', dependency_type: 'required' });
      return broken;
    },
  } as unknown as Network;
  const service = new ContentService(net);
  try {
    await fs.mkdir(path.join(root, 'mods'), { recursive: true });
    const zip = new AdmZip();
    zip.addFile('pack.mcmeta', Buffer.from('{}'));
    zip.writeZip(path.join(root, 'mods', 'a.jar'));
    await fs.writeFile(path.join(root, 'mods', 'b.jar'), 'not a zip');
    await writeJson(path.join(root, '.workbench', 'content.json'), entries);
    assert.deepEqual(await service.conflicts(instance), [
      'A: required absent',
      'b.jar: unreadable mod archive',
      'B: required absent',
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
