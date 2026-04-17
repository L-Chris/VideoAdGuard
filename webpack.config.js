const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const webpack = require('webpack');

const createConfig = (browser) => ({
  mode: 'production',
  devtool: false,
  optimization: {
    minimize: true,
  },
  entry: {
    content: './src/content.ts',
    popup: './src/popup.ts',
    background: './src/background.ts',
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/
      }
    ]
  },
  resolve: {
    extensions: ['.ts', '.js']
  },
  output: {
    filename: '[name].js',
    path: path.resolve(__dirname, `builds/${browser}`)
  },
  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        { from: 'src/popup.html', to: 'popup.html' },
        { from: '_locales', to: '_locales' },
        { from: 'icons', to: 'icons' },
        { from: `manifests/manifest-${browser}.json`, to: 'manifest.json' }
      ]
    })
  ]
});

module.exports = [
  createConfig('chrome'),
  createConfig('firefox')
];
