import path from 'path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig(({ mode }) => {
  const isProd = mode === 'production';

  return {
    build: {
      lib: {
        entry: path.resolve(__dirname, 'src/index.ts'),
        name: 'file-manager-lib',
        fileName: () => `index.d.ts`,
        formats: ['umd'],
      },
      sourcemap: isProd,
      rollupOptions: {
        external: ['@ethersphere/bee-js', 'cafe-utility', 'path', 'fs', 'stream', 'crypto'],
        output: {
          globals: {
            '@ethersphere/bee-js': 'BeeJS',
            'cafe-utility': 'cafeUtility',
            crypto: 'crypto',
            fs: 'fs',
            path: 'path',
          },
        },
      },
      define: {
        'process.env.ENV': JSON.stringify(isProd ? 'production' : 'development'),
        'process.env.IS_WEBPACK_BUILD': 'false',
      },
    },
    plugins: [
      dts({
        exclude: '**/tests/**',
        outDir: 'dist/types',
        entryRoot: 'src',
      }),
    ],
    extensions: ['.ts', '.js'],
  };
});
