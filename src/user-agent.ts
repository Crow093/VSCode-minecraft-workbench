import * as vscode from 'vscode';

export const extensionId = 'minecraft-workbench.minecraft-workbench';

export function userAgent(version: string): string {
  const value = version.trim();
  return value ? `MinecraftWorkbench/${value}` : 'MinecraftWorkbench';
}

/**
 * Reads the version from the installed manifest so the User-Agent always
 * matches the running build instead of drifting away from package.json.
 */
export function extensionVersion(): string {
  try {
    const value = vscode.extensions?.getExtension?.(extensionId)?.packageJSON?.version;
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}
