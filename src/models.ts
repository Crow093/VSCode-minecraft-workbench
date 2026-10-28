export type Loader = 'vanilla' | 'fabric' | 'quilt' | 'forge' | 'neoforge';
export type Mode = 'launcher' | 'developer';
export type ContentKind = 'mod' | 'resourcepack' | 'shader';
export interface Instance {
  id: string;
  name: string;
  minecraft: string;
  versionId?: string;
  loader: Loader;
  loaderVersion?: string;
  directory: string;
  java?: string;
  minMemory?: number;
  maxMemory?: number;
  jvmArgs?: string[];
  gameArgs?: string[];
  accountId?: string;
  gc?: 'default' | 'g1' | 'zgc';
  resolution?: { width: number; height: number; fullscreen: boolean };
  server?: string;
  backupBeforeLaunch?: boolean;
  lastPlayed?: string;
  playtimeSeconds?: number;
  installed?: boolean;
  createdAt: string;
}
export interface Account {
  id: string;
  name: string;
  kind: 'offline' | 'microsoft';
}
export interface Tokens {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
}
export interface JavaRuntime {
  path: string;
  version: string;
  major: number;
  architecture: string;
}
export interface Project {
  id: string;
  name: string;
  directory: string;
  minecraft: string;
  loader: Exclude<Loader, 'vanilla' | 'quilt'>;
  packageName: string;
  modId: string;
  buildJava?: number;
  buildJavaKey?: string;
}
export interface Content {
  file: string;
  kind: ContentKind;
  name: string;
  projectId?: string;
  versionId?: string;
  hash?: string;
  enabled: boolean;
}
export interface State {
  schema: 1;
  mode: Mode;
  instances: Instance[];
  accounts: Account[];
  projects: Project[];
  selectedInstance?: string;
  selectedAccount?: string;
  java: JavaRuntime[];
}
export interface VersionEntry {
  id: string;
  type: string;
  url: string;
  sha1?: string;
  releaseTime: string;
}
export interface VersionManifest {
  latest: { release: string; snapshot: string };
  versions: VersionEntry[];
}
export interface ModVersion {
  id: string;
  project_id: string;
  name: string;
  version_number: string;
  version_type?: 'release' | 'beta' | 'alpha';
  date_published?: string;
  downloads?: number;
  changelog?: string;
  game_versions: string[];
  loaders: string[];
  files: {
    url: string;
    filename: string;
    primary: boolean;
    hashes: { sha1: string; sha512?: string };
    size: number;
  }[];
  dependencies: {
    project_id?: string;
    version_id?: string;
    dependency_type: 'required' | 'optional' | 'incompatible' | 'embedded';
  }[];
}
