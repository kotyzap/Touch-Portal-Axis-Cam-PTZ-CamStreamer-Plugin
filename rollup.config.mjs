import commonjs from '@rollup/plugin-commonjs';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';

const isWatching = !!process.env.ROLLUP_WATCH;

/**
 * Touch Portal launches the plugin as a separate process (see entry.tp
 * plugin_start_cmd). We bundle everything to a single CommonJS file so the
 * launch command is just `node plugin/plugin.js` with no node_modules to ship.
 *
 * @type {import('rollup').RollupOptions}
 */
const config = {
    input: 'src/index.ts',
    output: {
        file: 'plugin/plugin.js',
        format: 'cjs',
        sourcemap: isWatching,
    },
    plugins: [
        typescript(),
        nodeResolve({ browser: false, exportConditions: ['node'], preferBuiltins: true }),
        commonjs(),
        // The root package is an ES module; mark the plugin/ output dir as
        // CommonJS so `node plugin/plugin.js` loads the CJS bundle correctly.
        {
            name: 'emit-cjs-package-file',
            generateBundle() {
                this.emitFile({ fileName: 'package.json', source: '{ "type": "commonjs" }', type: 'asset' });
            },
        },
    ],
};

export default config;
