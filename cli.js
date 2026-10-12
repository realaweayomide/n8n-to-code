#!/usr/bin/env node
// cli.js — convert an n8n workflow export from the command line.
//
//   node cli.js workflow.json                 print to stdout
//   node cli.js workflow.json -o out.js       write to a file
//   node cli.js ./folder --report             coverage stats across a whole folder

const { readFileSync, writeFileSync, readdirSync, statSync } = require('node:fs')
const { join, extname } = require('node:path')
const { convert } = require('./convert.js')

const args = process.argv.slice(2)
const target = args.find((a) => !a.startsWith('-'))
const outIdx = args.findIndex((a) => a === '-o' || a === '--out')
const out = outIdx !== -1 ? args[outIdx + 1] : null
const reportOnly = args.includes('--report')

if (!target) {
  console.log(`
n8n-to-code — turn an n8n workflow export into readable Node.js

  node cli.js workflow.json              print the converted code
  node cli.js workflow.json -o out.js    write it to a file
  node cli.js ./folder --report          coverage stats across many workflows
`)
  process.exit(0)
}

if (statSync(target).isDirectory()) {
  runFolder(target)
} else {
  const { code, report } = convert(readFileSync(target, 'utf8'))
  printReport(report)
  if (out) {
    writeFileSync(out, code, 'utf8')
    console.log(`\nWritten to ${out}\n`)
  } else if (!reportOnly) {
    console.log('\n' + '─'.repeat(70) + '\n')
    console.log(code)
  }
}

function printReport(r) {
  console.log(`\n  ${r.name}`)
  console.log(`  ${'─'.repeat(60)}`)
  console.log(`  nodes in file     ${r.totalNodes}  (${r.stickyNotes} sticky notes skipped)`)
  console.log(`  steps converted   ${r.translated} / ${r.steps}   →  ${r.coverage}% coverage`)
  if (r.needsDeps.length) console.log(`  needs             npm i ${r.needsDeps.join(' ')}`)
  if (r.unsupported.length) {
    console.log(`\n  needs wiring by hand:`)
    for (const u of r.unsupported.slice(0, 10)) {
      console.log(`    · ${u.name}  (${u.type.replace('n8n-nodes-base.', '')})`)
    }
    if (r.unsupported.length > 10) console.log(`    … and ${r.unsupported.length - 10} more`)
  }
}

// Batch mode — useful for sanity-checking the converter against a whole library.
function runFolder(dir) {
  const files = []
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f)
      try {
        if (statSync(p).isDirectory()) walk(p)
        else if (extname(f) === '.json') files.push(p)
      } catch {}
    }
  }
  walk(dir)

  let ok = 0, failed = 0, totalSteps = 0, totalDone = 0
  const missing = new Map()

  for (const f of files) {
    try {
      const { report } = convert(readFileSync(f, 'utf8'))
      ok++
      totalSteps += report.steps
      totalDone += report.translated
      for (const u of report.unsupported) missing.set(u.type, (missing.get(u.type) || 0) + 1)
    } catch {
      failed++
    }
  }

  console.log(`\n  Converted ${ok} workflows (${failed} unreadable)`)
  console.log(`  Overall step coverage: ${totalSteps ? Math.round((totalDone / totalSteps) * 100) : 0}%  (${totalDone}/${totalSteps})`)
  console.log(`\n  Most common node types still needing manual work:`)
  for (const [type, n] of [...missing.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`    ${String(n).padStart(6)}  ${type}`)
  }
  console.log('')
}
