import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import AdmZip from 'adm-zip';
import { Developer, validPackage } from '../src/developer';
import { Store } from '../src/store';
import { Network } from '../src/network';
import { Java } from '../src/java';

test('Java package names reject keywords and invalid segments', () => {
  for (const value of ['com.example.my_mod', 'org.sample.client'])
    assert.equal(validPackage(value), true);
  for (const value of [
    'com.class.mod',
    'com..mod',
    'com.Example.mod',
    'com.1mod',
    'com._.foo',
    '../x',
  ])
    assert.equal(validPackage(value), false);
});
test('official-style project templates receive metadata, Java packages and entrypoints', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-project-'));
  const store = new Store(path.join(root, 'storage'), () => {});
  const zip = new AdmZip();
  zip.addFile(
    'template/gradle.properties',
    Buffer.from('minecraft_version=1.21.1\ngroup=com.example\nmod_id=modid\n'),
  );
  zip.addFile('template/build.gradle', Buffer.from('group = project.group\n'));
  zip.addFile('template/settings.gradle', Buffer.from('pluginManagement {}\n'));
  zip.addFile('template/gradle/wrapper/gradle-wrapper.jar', Buffer.from('wrapper-fixture'));
  zip.addFile(
    'template/src/main/java/com/example/ExampleMod.java',
    Buffer.from(
      'package com.example;\n@EventBusSubscriber(modid = "modid")\npublic class ExampleMod { public static final String MOD_ID = "modid"; }',
    ),
  );
  zip.addFile(
    'template/src/main/resources/fabric.mod.json',
    Buffer.from(
      JSON.stringify({
        id: 'modid',
        name: 'Example Mod',
        authors: ['Example'],
        contact: { homepage: 'https://example.com' },
        entrypoints: { main: ['com.example.ExampleMod'] },
      }),
    ),
  );
  zip.addFile(
    'template/src/main/resources/modid.mixins.json',
    Buffer.from('{"package":"com.example.mixin"}'),
  );
  zip.addFile('template/src/main/resources/assets/modid/icon.png', Buffer.from('icon'));
  const net = {
    download: async (_url: string, target: string) => {
      await fs.mkdir(path.dirname(target), { recursive: true });
      zip.writeZip(target);
    },
  } as unknown as Network;
  const dev = new Developer(store, net, {} as Java);
  try {
    const project = await dev.create(
      {
        name: '1.21.1',
        minecraft: '1.21.1',
        loader: 'fabric',
        url: 'https://example.com/template.zip',
      },
      { name: 'Demo Mod', modId: 'demo_mod', packageName: 'org.sample.demo', parent: root },
      new AbortController().signal,
    );
    const source = await fs.readFile(
      path.join(project.directory, 'src/main/java/org/sample/demo/ExampleMod.java'),
      'utf8',
    );
    assert.match(source, /package org\.sample\.demo;/);
    assert.match(source, /"demo_mod"/);
    assert.match(source, /@EventBusSubscriber\(modid = "demo_mod"\)/);
    const metadata = JSON.parse(
      await fs.readFile(path.join(project.directory, 'src/main/resources/fabric.mod.json'), 'utf8'),
    );
    assert.equal(metadata.id, 'demo_mod');
    assert.equal(metadata.name, 'Demo Mod');
    assert.equal(metadata.entrypoints.main[0], 'org.sample.demo.ExampleMod');
    assert.deepEqual(metadata.authors, []);
    assert.deepEqual(metadata.contact, {});
    assert.equal(
      JSON.parse(
        await fs.readFile(
          path.join(project.directory, 'src/main/resources/demo_mod.mixins.json'),
          'utf8',
        ),
      ).package,
      'org.sample.demo.mixin',
    );
    await fs.access(path.join(project.directory, 'src/main/resources/assets/demo_mod/icon.png'));
    assert.equal(store.state.projects[0].id, project.id);
    await assert.rejects(
      dev.create(
        { name: '', minecraft: '1.21.1', loader: 'fabric', url: '' },
        { name: 'Demo', modId: 'demo_mod', packageName: 'org.sample.demo', parent: root },
        new AbortController().signal,
      ),
      /exists/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('build Java follows Loom artifact metadata and invalidates when the tool version changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-build-java-'));
  const store = new Store(path.join(root, 'store'), () => {});
  const project = {
    id: 'test',
    name: 'Test',
    modId: 'test',
    directory: root,
    packageName: 'com.example.test',
    loader: 'fabric' as const,
    minecraft: '1.21.1',
  };
  store.state.projects.push(project);
  const net = {
    text: async () =>
      '<snapshotVersion><extension>module</extension><value>1.19-20261022</value></snapshotVersion>',
    json: async (url: string) => ({
      variants: [{ attributes: { 'org.gradle.jvm.version': url.includes('1.19') ? 25 : 21 } }],
    }),
  } as unknown as Network;
  const dev = new Developer(store, net, {} as Java);
  try {
    await fs.writeFile(path.join(root, 'gradle.properties'), 'loom_version=1.19-SNAPSHOT');
    assert.equal(await dev.requiredJava(project), 25);
    await fs.writeFile(path.join(root, 'gradle.properties'), 'loom_version=1.10.5');
    assert.equal(await dev.requiredJava(project), 21);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('official template catalogs retain snapshot branches and prerelease MDKs', async () => {
  const network = {
    json: async (url: string) =>
      url.includes('fabric-example-mod')
        ? ['1.21.1', '26.4-snapshot-5', '1.21-pre1', 'main'].map((name) => ({
            name,
            commit: { sha: 'revision' },
          }))
        : ['MDK-1.21.1-ModDevGradle', 'MDK-26.4-beta-ModDevGradle', 'Other'].map((name) => ({
            name,
            default_branch: 'main',
          })),
  } as unknown as Network;
  const developer = new Developer({} as Store, network, {} as Java);
  const fabric = await developer.templates('fabric');
  assert.ok(fabric.some((t) => t.minecraft === '26.4-snapshot-5'));
  assert.ok(fabric.some((t) => t.minecraft === '1.21-pre1'));
  assert.ok(!fabric.some((t) => t.minecraft === 'main'));
  assert.ok((await developer.templates('neoforge')).some((t) => t.minecraft === '26.4-beta'));
});
