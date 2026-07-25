const esbuild = require('esbuild');

const commonConfig = {
  bundle: true,
  format: 'esm',
  target: 'es2020',
  loader: { '.csv': 'text' }
};

esbuild.build({
  ...commonConfig,
  entryPoints: ['src/index.js'],
  outfile: 'index.js',
  external: ['../../../../extensions.js', '../../../../script.js']
}).catch(() => process.exit(1));

esbuild.build({
  ...commonConfig,
  entryPoints: ['src/worker.js'],
  outfile: 'worker.js',
}).catch(() => process.exit(1));

