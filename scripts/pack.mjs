import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';
import archiver from 'archiver';

/**
 * Build a .tpp (Touch Portal plugin = a zip whose top-level folder is the
 * plugin folder). Touch Portal extracts it into its plugins directory, so the
 * folder name must match what entry.tp's plugin_start_cmd_* expect.
 */
const root = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const folderName = 'touch-portal-for-axis';
const outDir = path.join(root, 'dist');
await mkdir(outDir, { recursive: true });
const outFile = path.join(outDir, `${folderName}-v1.0.0.tpp`);

const output = createWriteStream(outFile);
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => console.log(`packed ${outFile} (${archive.pointer()} bytes)`));
archive.on('warning', (e) => console.warn(e));
archive.on('error', (e) => { throw e; });

archive.pipe(output);
// Touch Portal requires entry.tp at the ROOT of the plugin folder
// (plugins/<folderName>/entry.tp). Everything else (plugin.js, icon) stays
// under plugin/ because entry.tp's start cmd & imagepath point there.
archive.file(path.join(root, 'plugin', 'entry.tp'), { name: `${folderName}/entry.tp` });
archive.directory(path.join(root, 'plugin'), `${folderName}/plugin`);
await archive.finalize();
