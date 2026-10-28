import * as vscode from 'vscode';
import { Store } from './store';
import { Minecraft } from './minecraft';
import { ContentService } from './content';
import { Jobs } from './jobs';
import { Instance, Account, Project, Content, JavaRuntime } from './models';
import { Job } from './jobs';
import { t } from './config';
import { memorySettings } from './memory';

export type ItemValue = Instance | Account | Project | Content | JavaRuntime | Job;
export class Item extends vscode.TreeItem {
  constructor(
    label: string,
    readonly kind: string,
    readonly value?: ItemValue,
    icon?: string,
    command?: string,
    description?: string,
    expandable = false,
  ) {
    super(
      label,
      expandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    this.contextValue = kind;
    this.description = description;
    if (icon) this.iconPath = new vscode.ThemeIcon(icon);
    if (command)
      this.command = { title: label, command: `minecraftWorkbench.${command}`, arguments: [this] };
  }
}
export type Section =
  | 'home'
  | 'instances'
  | 'projects'
  | 'content'
  | 'accounts'
  | 'java'
  | 'downloads';
export class View implements vscode.TreeDataProvider<Item>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(
    readonly section: Section,
    private readonly store: Store,
    private readonly minecraft: Minecraft,
    private readonly content: ContentService,
    private readonly jobs: Jobs,
  ) {}
  refresh() {
    this.emitter.fire(undefined);
  }
  getTreeItem(item: Item) {
    return item;
  }
  async getChildren(_parent?: Item): Promise<Item[]> {
    const state = this.store.state;
    if (this.section === 'home')
      return [
        new Item(
          state.mode === 'launcher'
            ? t('Launcher Mode', '启动模式')
            : t('Developer Mode', '开发模式'),
          'mode',
          undefined,
          state.mode === 'launcher' ? 'game' : 'code',
          'mode',
          t('Switch mode', '切换模式'),
        ),
        new Item(
          t('Language', '语言'),
          'action',
          undefined,
          'globe',
          'language',
          t('English', '简体中文'),
        ),
        new Item(t('Settings', '设置'), 'action', undefined, 'settings-gear', 'settings'),
      ];
    if (this.section === 'instances') {
      return state.instances.map((instance) => {
        const running = this.minecraft.running.has(instance.id);
        const item = new Item(
          instance.name,
          running ? 'runningInstance' : 'instance',
          instance,
          running
            ? 'vm-running'
            : state.selectedInstance === instance.id
              ? 'pass-filled'
              : 'package',
          'inspectInstance',
          `${instance.minecraft} · ${instance.loader}${instance.installed ? '' : t(' · Not installed', ' · 未安装')}`,
          false,
        );
        item.id = instance.id;
        item.tooltip = `${instance.name}\n${instance.directory}`;
        return item;
      });
    }
    if (this.section === 'projects')
      return state.projects.map(
        (project) =>
          new Item(
            project.name,
            'project',
            project,
            'code',
            'projectActions',
            `${project.minecraft} · ${project.loader}`,
          ),
      );
    if (this.section === 'accounts')
      return state.accounts.map(
        (account) =>
          new Item(
            account.name,
            'account',
            account,
            account.id === state.selectedAccount ? 'pass-filled' : 'account',
            'selectAccount',
            account.kind === 'microsoft' ? 'Microsoft' : t('Offline', '离线'),
          ),
      );
    if (this.section === 'java')
      return state.java.map(
        (java) =>
          new Item(
            `Java ${java.major}`,
            'java',
            java,
            'symbol-method',
            'javaActions',
            `${java.version} · ${java.architecture}`,
          ),
      );
    if (this.section === 'downloads')
      return this.jobs.items.map((job) => {
        const icon = {
          running: 'loading~spin',
          done: 'check',
          cancelled: 'circle-slash',
          failed: 'error',
        }[job.status];
        const states = {
          running: t('Running', '运行中'),
          done: t('Completed', '已完成'),
          cancelled: t('Cancelled', '已取消'),
          failed: t('Failed', '失败'),
        };
        const item = new Item(
          job.label,
          job.status === 'running' ? 'runningJob' : 'job',
          job,
          icon,
          'jobActions',
          job.detail || states[job.status],
        );
        item.id = job.id;
        return item;
      });
    const instance = this.store.selected;
    const browse = new Item(
      t('Browse content', '浏览内容'),
      'action',
      undefined,
      'extensions',
      'browse',
    );
    if (!instance) return [browse];
    const counts = await this.content.list(instance);
    return [
      new Item(
        t('Mods', '模组'),
        'mod',
        undefined,
        'extensions',
        'installed',
        String(counts.filter((i) => i.kind === 'mod').length),
      ),
      new Item(
        t('Resource packs', '资源包'),
        'resourcepack',
        undefined,
        'file-media',
        'installed',
        String(counts.filter((i) => i.kind === 'resourcepack').length),
      ),
      new Item(
        t('Shaders', '光影包'),
        'shader',
        undefined,
        'sparkle',
        'installed',
        String(counts.filter((i) => i.kind === 'shader').length),
      ),
      browse,
    ];
  }

  dispose() {
    this.emitter.dispose();
  }
}
export function updateStatus(status: vscode.StatusBarItem, store: Store) {
  const account = store.state.accounts.find((a) => a.id === store.state.selectedAccount);
  status.text = `$(game) ${store.state.mode === 'launcher' ? t('Launcher', '启动器') : t('Developer', '开发')}${store.selected && store.state.mode === 'launcher' ? ` · ${store.selected.name}` : ''}`;
  status.tooltip = `${account?.name || t('No account', '未选择账户')} · ${memorySettings(store.selected).maxMemory} MB`;
  status.command = 'minecraftWorkbench.mode';
  status.show();
}
