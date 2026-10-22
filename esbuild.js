const esbuild = require('esbuild');
const configs = [
  { entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', target: 'node18', format: 'cjs', external: ['vscode'] },
  { entryPoints: ['src/webview/main.ts'], outfile: 'dist/webview.js', platform: 'browser', target: 'es2022', format: 'iife' },
  // Dev-only thread UI preview (fixtures included); excluded from the VSIX.
  { entryPoints: ['src/preview/main.ts'], outfile: 'dist/preview.js', platform: 'browser', target: 'es2022', format: 'iife' },
  { entryPoints: ['src/test/extension-host.ts'], outfile: 'dist/host-test.js', platform: 'node', target: 'node18', format: 'cjs', external: ['vscode'] },
  { entryPoints: ['src/test/run.ts'], outfile: 'dist/test.js', platform: 'node', target: 'node18', format: 'cjs', alias: { vscode: require('path').resolve('src/test/vscode.ts') } }
];
(async () => {
  for (const config of configs) {
    const options = { ...config, bundle: true, sourcemap: true, logLevel: 'info' };
    if (process.argv.includes('--watch')) await (await esbuild.context(options)).watch();
    else await esbuild.build(options);
  }
})().catch(() => process.exit(1));
