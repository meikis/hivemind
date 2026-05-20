export declare const SCALAR_TARGETS: readonly string[];
export declare const MARKETPLACE_PATH: string;

export interface SyncResult {
  writes: number;
  skips: number;
  version: string;
}

export interface SyncOptions {
  root?: string;
  log?: (msg: string) => void;
}

export declare function syncVersions(opts?: SyncOptions): SyncResult;
