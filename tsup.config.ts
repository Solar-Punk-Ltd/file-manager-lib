import { defineConfig } from 'tsup';

const stubForeignPlatform = (name: string, filter: RegExp, exportNames: string[]) => ({
  name,
  setup(build: any) {
    build.onResolve({ filter }, (args: any) => ({ path: args.path, namespace: name }));
    build.onLoad({ filter: /.*/, namespace: name }, () => ({
      loader: 'ts',
      contents:
        `const unavailable = () => { throw new Error('Platform module loaded on the wrong platform'); };\n` +
        exportNames.map((n) => `export const ${n} = unavailable;`).join('\n'),
    }));
  },
});

const stubNodeInBrowser = stubForeignPlatform('stub-node-in-browser', /(?:^|\/)(upload-node|fs-node)$/, [
  'processUploadNode',
  'isDir',
  'readFile',
  'getContentType',
]);
const stubBrowserInNode = stubForeignPlatform('stub-browser-in-node', /(?:^|\/)upload-browser$/, [
  'processUploadBrowser',
]);

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    platform: 'node',
    outDir: 'dist/node',
    dts: true,
    treeshake: true,
    clean: true,
    esbuildPlugins: [stubBrowserInNode],
    outExtension({ format }) {
      return { js: format === 'cjs' ? '.cjs' : '.mjs' };
    },
  },
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    platform: 'browser',
    outDir: 'dist/browser',
    dts: false,
    treeshake: true,
    external: ['fs', 'path', 'node:fs', 'node:path'],
    esbuildPlugins: [stubNodeInBrowser],
    outExtension({ format }) {
      return { js: format === 'cjs' ? '.cjs' : '.mjs' };
    },
  },
]);
