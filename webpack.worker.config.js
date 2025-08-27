const path = require('path');

module.exports = {
  mode: 'production',
  entry: './src/workers/stomp-worker-bundled.js',
  output: {
    filename: 'stomp-worker.js',
    path: path.resolve(__dirname, 'src/assets'),
    clean: false
  },
  resolve: {
    extensions: ['.js', '.ts']
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: ['@babel/preset-env']
          }
        }
      }
    ]
  },
  target: 'webworker',
  optimization: {
    minimize: true
  }
};
