// The parts of Node that the build's plugin (serviceWorker.ts) uses. The web app has no @types/node (it is not a dependency, and the
// app's code never runs in Node); the build's config and plugin run there, and these few signatures are all they need of it. Only the
// `build` project (tsconfig.json here) sees them: the app and the worker are checked without.
declare module "node:fs/promises" {
  export interface Dirent {
    readonly name: string;
    readonly parentPath: string;
    isFile(): boolean;
  }
  export function readdir(path: string, options: { recursive: true; withFileTypes: true }): Promise<Dirent[]>;
}
declare module "node:path" {
  export function join(...parts: string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...parts: string[]): string;
}
