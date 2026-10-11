export interface LauncherConfig {
  root: string;
  env: NodeJS.ProcessEnv;
  port: number;
  dataDir: string;
  databasePath: string;
  runtimeDir: string;
  recordPath: string;
  logPath: string;
  url: string;
}
export function resolveConfiguration(root: string, inherited?: NodeJS.ProcessEnv): LauncherConfig;
export function redact(message: unknown, env?: NodeJS.ProcessEnv): string;
export function sourceFingerprint(root: string): string;
export function prepareRuntime(config: LauncherConfig): Promise<void>;
export function inspectListener(config: LauncherConfig): { owned: boolean; pid?: number; birth?: string; args?: string } | null;
export function launch(action: string, options?: { root?: string; env?: NodeJS.ProcessEnv; open?: boolean; prepare?: (config: LauncherConfig) => void | Promise<void> }): Promise<{ running: boolean; reused?: boolean; pid?: number | null; config: LauncherConfig }>;
