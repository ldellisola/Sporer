// The parts of Node that the performance spec uses. The web app has no @types/node (it is not a dependency, and the app's code
// never runs in Node); the spec runs there, under Playwright, and these few signatures are all it needs of it.
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function mkdirSync(path: string, options: { recursive: true }): void;
}
declare module "node:path" {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
}
declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}
