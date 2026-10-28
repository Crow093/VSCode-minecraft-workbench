import * as vscode from 'vscode';
export const config = <T>(key: string, fallback: T): T =>
  vscode.workspace.getConfiguration('minecraftWorkbench').get<T>(key, fallback);
export function t(en: string, zh: string): string {
  const locale = config<string>('language', 'en');
  return locale === 'zh-cn' ||
    (locale === 'auto' && vscode.env.language.toLowerCase().startsWith('zh'))
    ? zh
    : en;
}
export async function trusted(): Promise<void> {
  if (!vscode.workspace.isTrusted)
    throw new Error(
      t(
        'Trust this workspace before running Minecraft or Gradle.',
        '请先信任工作区，再运行 Minecraft 或 Gradle。',
      ),
    );
}
