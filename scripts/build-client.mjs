import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const result = await build({
  entryPoints: [resolve(root, 'src/client/index.tsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  minify: true,
  write: false,
});

const source = result.outputFiles[0]?.text;
if (!source) throw new Error('The Client bundle did not produce JavaScript output.');

const output = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(manifest.name)},
  factory(require) {
    const module = { exports: {} };
    const exports = module.exports;
${source.split('\n').map(line => `    ${line}`).join('\n')}
    return module.exports;
  },
});
`;

await writeFile(resolve(root, 'dist/client/index.js'), output, 'utf8');
