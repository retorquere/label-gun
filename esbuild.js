#!/usr/bin/env node

const esbuild = require('esbuild')
const fs = require('fs')
const path = require('path')
const { parse } = require('yaml')
const objectDotParser = require('object-dot-parser')

const dependencies = new Set
const dependenciesPlugin = {
  name: 'log-imports',
  setup(build) {
    const sources = new Set(build.initialOptions.entryPoints.map(_ => path.join(__dirname, _)))
    build.onResolve({ filter: /.*/ }, args => {
      if (args.path[0] === '@') {
        dependencies.add(args.path.split('/').slice(0, 2).join('/'))
      }
      else if (args.path[0] !== '.') {
        dependencies.add(args.path.split('/')[0])
      }
      return null
    })
  },
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath)
    return true
  } catch (err) {
    return false
  }
}

const Config = new class {
  constructor() {
    const output = path.join(__dirname, 'src/config.ts')
    const action = parse(fs.readFileSync(path.join(__dirname, 'action.yml'), 'utf-8'))
    const inputs = objectDotParser(action.inputs)
    const outputs = objectDotParser(action.outputs)
    const prefix = fs.readFileSync(output, 'utf-8').replace(/export const config[\s\S]*/, '')
    fs.writeFileSync(output, prefix + this.walk(inputs))
    const getters = Object.keys(this.#getters)
    if (getters.length) throw new Error(`unused config getters ${JSON.stringify(getters)}`)
  }

  #getters = {
    'log.regex': `core.getInput('log.regex') ? new RegExp(core.getInput('log.regex')) : (undefined as unknown as RegExp)`,
    'issue.state': `getEnum('issue.state', ['all', 'open', 'closed']) as 'all' | 'open' | 'closed'`,
    'verbose': `getBool('verbose', 'false')`,
    'assign': `getBool('assign', 'false')`,
  }
  getter(path, k) {
    k = `${path}.${k}`.substring(1)

    if (this.#getters[k]) {
      const getter = this.#getters[k]
      delete this.#getters[k]
      return getter
    }
    else {
      return `core.getInput('${k}')`
    }
  }

  description(v) {
    let desc = ''
    if (v.required) desc += 'required; '
    if (v.default) desc += `default: ${JSON.stringify(v.default)}, `
    return desc + v.description
  }

  walk(inputs, indent = '', path = '') {
    let code = indent ? '' : 'export const config = {\n'
    for (const [k, v] of Object.entries(inputs)) {
      if (v.description) {
        code += `  ${indent}// ${this.description(v)}\n`
        code += `  ${indent}${k.replace(/-[a-z]/g, m => m.substring(1).toUpperCase())}: ${this.getter(path, k)},\n\n`
      }
      else {
        code += `\n  ${indent}${k}: {\n`
        code += this.walk(v, indent + '  ', `${path}.${k}`)
        code += `  ${indent}},\n`
      }
    }
    code += indent ? '' : '}\n'
    return code
  }
}

const builtInModules = new Set(require('module').builtinModules)
async function build() {
  try {
    const { metafile } = await esbuild.build({
      entryPoints: ['src/main.ts'],
      bundle: true,
      outfile: 'dist/index.js',
      plugins: [dependenciesPlugin],
      sourcemap: true,
      external:[ 'node:*', ...builtInModules ],
    })

    let licenses = ''
    for (const dependency of [...dependencies].sort()) {
      if (dependency.startsWith('node:') || builtInModules.has(dependency)) continue
      const license = ['', '.txt', '.md'].map(ext => path.join('node_modules', dependency, `LICENSE${ext}`)).find(_ => fileExists(_))
      if (license) {
        licenses += `\n# ${dependency}\n${await fs.promises.readFile(license, 'utf-8')}`
        if (!licenses.endsWith('\n')) licenses += '\n'
      }
    }
    await fs.promises.writeFile('dist/licenses.txt', licenses.trim())

  }
  catch (error) {
    console.error('Build failed:', error)
    process.exit(1)
  }
}

build()
