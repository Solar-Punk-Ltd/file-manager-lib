import Path from 'path';
import { Configuration, DefinePlugin, WebpackPluginInstance } from 'webpack';

interface WebpackEnvParams {
  debug: boolean;
  fileName: string;
}

const base = async (env?: Partial<WebpackEnvParams>): Promise<Configuration> => {
  const isProduction = process.env['NODE_ENV'] === 'production';
  const filename = env?.fileName || ['index.browser', isProduction ? '.min' : null, '.js'].filter(Boolean).join('');
  const entry = Path.resolve(__dirname, 'src');
  const path = Path.resolve(__dirname, 'dist');
  const plugins: WebpackPluginInstance[] = [
    new DefinePlugin({
      'process.env.ENV': process.env['NODE_ENV'] || 'development',
      'process.env.IS_WEBPACK_BUILD': 'true',
    }),
  ];

  return {
    bail: Boolean(isProduction),
    mode: (process.env['NODE_ENV'] as 'production') || 'development',
    devtool: isProduction ? 'source-map' : 'cheap-module-source-map',
    entry,
    output: {
      path,
      filename,
      sourceMapFilename: '[file].map[query]',
      library: 'file-manager-lib',
      libraryTarget: 'umd',
      globalObject: 'this',
    },
    module: {
      rules: [
        {
          test: /\.(ts|js)$/,
          use: {
            loader: 'babel-loader',
          },
        },
      ],
    },
    resolve: {
      extensions: ['.ts', '.js'],
      fallback: {
        path: false,
        fs: false,
        stream: false,
        crypto: false,
      },
    },
    plugins,
    performance: {
      hints: false,
    },
  };
};

export default async (env?: Partial<WebpackEnvParams>): Promise<Configuration> => {
  const nodeEnv = process.env['NODE_ENV'] || 'development';

  if (nodeEnv == 'debug') {
    const config = {
      ...(await base(env)),
      plugins: [],
      profile: true,
    };

    return config;
  }

  return base(env);
};
