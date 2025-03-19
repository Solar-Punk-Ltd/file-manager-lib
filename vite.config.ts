import path from 'path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/index.ts'),
      name: 'file-manager-lib',
      fileName: () => `index.js`, // always output "index.js"
      formats: ['umd'],
    },    
    sourcemap: process.env.NODE_ENV === 'production',
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
    minify: process.env.NODE_ENV === 'production' ? 'terser' : false,
    terserOptions: {
      parse: { ecma: 2018 },
      compress: { ecma: 5 },
      mangle: { safari10: true },
      output: { ecma: 5, comments: false },
    },
  },
  define: {
    'process.env.ENV': JSON.stringify(process.env.NODE_ENV || 'development'),
    'process.env.IS_WEBPACK_BUILD': 'false',
  },
  plugins: [dts()],
  resolve: {
    alias: {
      fs: path.resolve(__dirname, 'empty.js'),
      path: path.resolve(__dirname, 'empty.js'),
      stream: path.resolve(__dirname, 'empty.js'),
      crypto: path.resolve(__dirname, 'empty.js'),
    },
    extensions: ['.ts', '.js'],
  },
});
