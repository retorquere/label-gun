#!/usr/bin/env node

const esbuild = require('esbuild')
const { builtinModules } = require('module')

const external = [...builtinModules, ...builtinModules.map(name => `node:${name}`)]

esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'dist/index.js',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  external,
}).catch(error => {
  console.error(error)
  process.exit(1)
})