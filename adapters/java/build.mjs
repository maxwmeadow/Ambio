// Builds ambio-agent.jar, the JVM run recorder (src/dev/ambio/agent).
//
//   node adapters/java/build.mjs
//
// Needs a JDK 11+ (JAVA_HOME, or javac on PATH). The jar is committed, so
// building Ambio itself never needs one; rerun this after changing the agent.
// ASM is downloaded at a pinned version and checksum, relocated into the
// agent's package, and bundled (BSD-3-Clause, ASM-LICENSE.txt).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUILD = join(HERE, '.build')
const ASM_VERSION = '9.10.1'
const ASM = {
  asm: 'ed825d10ab1399c8c0cb669e688cf0c8c82629b4c8399b58352b68e92ca10fcb',
  'asm-commons': '6d0abefb7cbf972ea16edb37ec14835372505063a45f976ab7ea889ed9497895',
}
const bin = name => {
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  return process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', exe) : exe
}
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' })
const sources = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith('.java') ? [join(dir, entry.name)] : [])

mkdirSync(BUILD, { recursive: true })
const jars = {}
for (const [name, sha256] of Object.entries(ASM)) {
  const file = join(BUILD, `${name}-${ASM_VERSION}.jar`)
  if (!existsSync(file)) {
    const url = `https://repo1.maven.org/maven2/org/ow2/asm/${name}/${ASM_VERSION}/${name}-${ASM_VERSION}.jar`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${url}: ${res.status}`)
    writeFileSync(file, Buffer.from(await res.arrayBuffer()))
  }
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex')
  if (actual !== sha256) throw new Error(`${file}: sha256 ${actual}, expected ${sha256}`)
  jars[name] = file
}
const classpath = Object.values(jars).join(process.platform === 'win32' ? ';' : ':')

for (const dir of ['classes', 'tools', 'shaded']) rmSync(join(BUILD, dir), { recursive: true, force: true })
// --release 8: the agent runs inside whatever JVM the user's project uses.
run(bin('javac'), ['--release', '8', '-Xlint:-options', '-g', '-cp', classpath, '-d', join(BUILD, 'classes'), ...sources(join(HERE, 'src'))])
run(bin('javac'), ['-cp', classpath, '-d', join(BUILD, 'tools'), join(HERE, 'tools', 'Shade.java')])

const shade = (...args) => run(bin('java'), ['-cp', `${join(BUILD, 'tools')}${process.platform === 'win32' ? ';' : ':'}${classpath}`, 'Shade', join(BUILD, 'shaded'), ...args])
shade(join(BUILD, 'classes'))
shade(jars.asm)
shade(jars['asm-commons'])

mkdirSync(join(BUILD, 'shaded', 'META-INF'), { recursive: true })
copyFileSync(join(HERE, 'ASM-LICENSE.txt'), join(BUILD, 'shaded', 'META-INF', 'ASM-LICENSE.txt'))
const manifest = join(BUILD, 'MANIFEST.MF')
writeFileSync(manifest, 'Premain-Class: dev.ambio.agent.Agent\nCan-Redefine-Classes: false\nCan-Retransform-Classes: false\n')
const out = join(HERE, 'ambio-agent.jar')
run(bin('jar'), ['--create', '--file', out, '--manifest', manifest, '-C', join(BUILD, 'shaded'), '.'])
console.log(`Done - ${out}`)
