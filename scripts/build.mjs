import * as esbuild from 'esbuild';
const options = {
  entryPoints: ['src/extension.ts', 'src/cli.ts', 'src/core.ts', 'src/render.ts'],
  bundle: true, platform: 'node', target: 'node20', format: 'cjs',
  outdir: 'dist', external: ['vscode'], sourcemap: true, logLevel: 'info'
};
if (process.argv.includes('--watch')) {
  const context = await esbuild.context(options);
  await context.watch();
} else await esbuild.build(options);
