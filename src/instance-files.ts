import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import AdmZip from 'adm-zip';
import { Instance, ContentKind, Content } from './models';
import { Store } from './store';
import { ContentService, contentFolders } from './content';
import { exists, filename, hashFile, rejectSymlinkParents, writeJson } from './files';
import { contentFile } from './modrinth';

export class InstanceFiles {
  constructor(
    private readonly store: Store,
    private readonly content: ContentService,
  ) {}
  async clone(
    instance: Instance,
    parent: string,
    name: string,
    worlds: boolean,
    signal: AbortSignal,
  ): Promise<Instance> {
    if (!path.isAbsolute(parent) || !name.trim()) throw new Error('Invalid instance settings');
    const id = randomUUID();
    const directory = path.join(parent, id);
    const stage = directory + '.copying';
    try {
      await fs.cp(instance.directory, stage, {
        recursive: true,
        mode: constants.COPYFILE_FICLONE,
        filter: async (source) => {
          signal.throwIfAborted();
          const relative = path.relative(instance.directory, source).replaceAll(path.sep, '/');
          if (
            relative === 'logs' ||
            relative === 'crash-reports' ||
            relative.startsWith('.workbench/backups') ||
            relative.startsWith('.workbench/staging') ||
            relative.startsWith('.workbench/history') ||
            (!worlds && relative === 'saves')
          )
            return false;
          if ((await fs.lstat(source)).isSymbolicLink())
            throw new Error('Symbolic links are not allowed in managed paths');
          return true;
        },
      });
      signal.throwIfAborted();
      await fs.rename(stage, directory);
      const copy: Instance = {
        ...structuredClone(instance),
        id,
        directory,
        name: name.trim(),
        createdAt: new Date().toISOString(),
        lastPlayed: undefined,
        playtimeSeconds: 0,
      };
      this.store.state.instances.push(copy);
      this.store.state.selectedInstance = id;
      await this.store.save();
      return copy;
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
  }
  async importLocal(instance: Instance, kind: ContentKind, paths: string[]) {
    const folder = path.join(instance.directory, contentFolders[kind]);
    await rejectSymlinkParents(instance.directory, path.join(folder, 'file'));
    const existing = await this.content.list(instance);
    const pending: Content[] = [];
    const stage = path.join(instance.directory, '.workbench', 'local-import', randomUUID());
    await rejectSymlinkParents(instance.directory, stage);
    await fs.mkdir(stage, { recursive: true });
    try {
      for (const source of paths) {
        const name = filename(path.basename(source));
        if (!(kind === 'mod' ? /\.jar$/i : /\.zip$/i).test(name))
          throw new Error('Invalid content file');
        if ((await exists(path.join(folder, name))) || pending.some((i) => i.file === name))
          throw new Error(`Target filename already exists: ${name}`);
        const archive = new AdmZip(source);
        if (!archive.getEntries().length) throw new Error('Invalid content file');
        await fs.copyFile(source, path.join(stage, name));
        pending.push({ file: name, name, kind, enabled: true });
      }
      await fs.mkdir(folder, { recursive: true });
      for (const item of pending)
        await fs.rename(path.join(stage, item.file), path.join(folder, item.file));
      await writeJson(path.join(instance.directory, '.workbench', 'content.json'), [
        ...existing,
        ...pending,
      ]);
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
  }
  async exportPack(instance: Instance, destination: string, signal: AbortSignal) {
    const archive = new AdmZip();
    const items = await this.content.list(instance);
    const remote = new Set<string>();
    const files: {
      path: string;
      hashes: { sha1: string };
      downloads: string[];
      fileSize: number;
      env: { client: string; server: string };
    }[] = [];
    for (const item of items.filter((i) => i.enabled && i.versionId && i.hash)) {
      signal.throwIfAborted();
      const relative = `${contentFolders[item.kind]}/${filename(item.file)}`;
      const target = path.join(instance.directory, relative);
      await rejectSymlinkParents(instance.directory, target);
      const hash = await hashFile(target);
      if (hash !== item.hash) continue;
      const version = await this.content.version(item.versionId!);
      const file = version.files.find((f) => f.hashes.sha1 === hash) || contentFile(version);
      if (file.hashes.sha1 !== hash || !file.url.startsWith('https://')) continue;
      files.push({
        path: relative,
        hashes: { sha1: hash },
        downloads: [file.url],
        fileSize: file.size,
        env: { client: 'required', server: 'unsupported' },
      });
      remote.add(relative);
    }
    let size = 0;
    const walk = async (folder: string) => {
      if (!(await exists(folder))) return;
      await rejectSymlinkParents(instance.directory, folder);
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
        signal.throwIfAborted();
        const full = path.join(folder, entry.name);
        if (entry.isSymbolicLink())
          throw new Error('Symbolic links are not allowed in managed paths');
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        const relative = path.relative(instance.directory, full).replaceAll(path.sep, '/');
        if (!entry.isFile() || remote.has(relative) || entry.name.endsWith('.disabled')) continue;
        size += (await fs.stat(full)).size;
        if (size > 1024 ** 3) throw new Error('Local pack overrides exceed 1 GB');
        archive.addFile(`overrides/${relative}`, await fs.readFile(full));
      }
    };
    for (const folder of ['mods', 'resourcepacks', 'shaderpacks', 'config', 'defaultconfigs'])
      await walk(path.join(instance.directory, folder));
    const dependencies: Record<string, string> = { minecraft: instance.minecraft };
    const loader = {
      vanilla: '',
      fabric: 'fabric-loader',
      quilt: 'quilt-loader',
      forge: 'forge',
      neoforge: 'neoforge',
    }[instance.loader];
    if (loader && instance.loaderVersion) dependencies[loader] = instance.loaderVersion;
    archive.addFile(
      'modrinth.index.json',
      Buffer.from(
        JSON.stringify(
          {
            formatVersion: 1,
            game: 'minecraft',
            versionId: '1.0.0',
            name: instance.name,
            files,
            dependencies,
          },
          null,
          2,
        ),
      ),
    );
    signal.throwIfAborted();
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      archive.writeZip(temporary);
      await fs.rename(temporary, destination);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}
