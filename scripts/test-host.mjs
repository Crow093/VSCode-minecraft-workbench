import { runTests } from '@vscode/test-electron';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root =
  process.env.MW_TEST_DATA || (await mkdtemp(path.join(tmpdir(), 'minecraft-workbench-host-')));
await mkdir(path.join(root, 'User'), { recursive: true });
await writeFile(
  path.join(root, 'User', 'settings.json'),
  JSON.stringify({
    'minecraftWorkbench.storageDirectory': path.join(root, 'storage'),
    'minecraftWorkbench.autoOpenProject': false,
    'workbench.startupEditor': 'none',
  }),
);
console.log(`Test data: ${root}`);
await runTests({
  ...(process.env.VSCODE_EXECUTABLE ? { vscodeExecutablePath: process.env.VSCODE_EXECUTABLE } : {}),
  extensionDevelopmentPath: process.cwd(),
  extensionTestsPath: path.resolve(process.env.MW_TEST_ENTRY || 'test/host.cjs'),
  launchArgs: [
    '--user-data-dir',
    root,
    '--extensions-dir',
    path.join(root, 'extensions'),
    '--disable-extensions',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    process.cwd(),
  ],
});
