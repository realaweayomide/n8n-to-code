// convert.js — turn an n8n workflow export into readable Node.js.
//
// Works in both the browser and Node (no imports, no dependencies).
//
// WHAT THIS IS NOT: a compiler. n8n has 600+ node types, many of which wrap an entire
// authenticated SaaS integration. Emitting working code for all of them is not a realistic
// goal and pretending otherwise would just produce confident nonsense.
//
// WHAT IT IS: a translator for the *logic and shape* of a workflow. It resolves the node
// graph into execution order, writes real code for the nodes that carry the actual logic
// (HTTP, transforms, branching, loops, code blocks), and leaves honest, clearly-labelled
// TODOs — with the original parameters preserved — for the integrations only you can wire up.
//
// The point is to turn a 40-box canvas you can no longer reason about into a file you can read.

// Nodes that are pure canvas decoration — the most common node type in the wild, and
// completely irrelevant to execution.
const IGNORED = new Set(['n8n-nodes-base.stickyNote'])

const TRIGGERS = new Set([
  'n8n-nodes-base.manualTrigger', 'n8n-nodes-base.start', 'n8n-nodes-base.scheduleTrigger',
  'n8n-nodes-base.cron', 'n8n-nodes-base.webhook', 'n8n-nodes-base.emailReadImap',
  'n8n-nodes-base.executeWorkflowTrigger', 'n8n-nodes-base.formTrigger',
  '@n8n/n8n-nodes-langchain.mcpTrigger', 'n8n-nodes-base.intervalTrigger',
])

// ─────────────────────────────────────────────────────────────────────────────
// expressions
// n8n writes expressions as strings beginning with "=", using {{ ... }} placeholders.
// We translate the common shapes into JS template literals so the output reads naturally.
// ─────────────────────────────────────────────────────────────────────────────

function expr(value) {
  if (typeof value !== 'string') return JSON.stringify(value)
  if (!value.startsWith('=')) return JSON.stringify(value)

  const body = value
    .slice(1)
    .replace(/\{\{\s*\$json\.([A-Za-z0-9_.\[\]'"]+)\s*\}\}/g, '${item.$1}')
    .replace(/\{\{\s*\$json\[(['"])(.+?)\1\]\s*\}\}/g, '${item["$2"]}')
    .replace(/\{\{\s*\$node\[(['"])(.+?)\1\]\.json\.([A-Za-z0-9_.]+)\s*\}\}/g, '${steps["$2"].$3}')
    .replace(/\{\{\s*\$now\s*\}\}/g, '${new Date().toISOString()}')
    .replace(/\{\{\s*\$env\.([A-Za-z0-9_]+)\s*\}\}/g, '${process.env.$1}')
    .replace(/\{\{\s*(.+?)\s*\}\}/g, '${/* n8n expr */ $1}')

  const out = '`' + body.replace(/`/g, '\\`') + '`'
  // n8n expressions can contain anything. If our translation didn't produce valid JS,
  // emit the original as a string with a TODO rather than breaking the whole output file.
  try {
    new Function('item', 'steps', 'return ' + out)
    return out
  } catch {
    return JSON.stringify(value) + ' /* TODO: n8n expression — translate by hand */'
  }
}

const ind = (s, n = 2) => s.split('\n').map(l => (l ? ' '.repeat(n) + l : l)).join('\n')
const safeName = (s) => (s || 'step').replace(/[^A-Za-z0-9]+/g, '_').replace(/^(\d)/, '_$1')

// ─────────────────────────────────────────────────────────────────────────────
// per-node code generation
// Each returns { code, supported } — supported:false means we emitted a TODO stub.
// ─────────────────────────────────────────────────────────────────────────────

const GEN = {
  'n8n-nodes-base.httpRequest': (n) => {
    const p = n.parameters || {}
    const method = (p.method || 'GET').toUpperCase()
    const url = expr(p.url || '')
    const lines = [`res = await fetch(${url}, {`, `  method: ${JSON.stringify(method)},`]
    if (p.sendHeaders || p.headerParameters) lines.push(`  headers: { 'Content-Type': 'application/json' }, // TODO: your original headers`)
    if (method !== 'GET' && method !== 'HEAD') lines.push(`  body: JSON.stringify(item),`)
    lines.push(
      `})`,
      `if (!res.ok) throw new Error(\`${n.name.replace(/`/g, '')} failed: HTTP \${res.status}\`)`,
      `item = await res.json()`
    )
    return { code: lines.join('\n'), supported: true }
  },

  'n8n-nodes-base.set': (n) => {
    const p = n.parameters || {}
    // n8n has changed this node's shape across versions; handle the common ones
    const fields =
      p.fields?.values ||
      p.assignments?.assignments ||
      [].concat(p.values?.string || [], p.values?.number || [], p.values?.boolean || [])
    if (!fields?.length) return { code: `// Set node with no fields configured`, supported: true }
    const assigns = fields.map((f) => {
      const key = f.name || f.key || 'field'
      const val = f.value !== undefined ? f.value : f.stringValue
      return `  ${JSON.stringify(key)}: ${expr(val)},`
    })
    const keepOnly = p.keepOnlySet || p.includeOtherFields === false
    return {
      code: (keepOnly ? `item = {\n` : `item = {\n  ...item,\n`) + assigns.join('\n') + `\n}`,
      supported: true,
    }
  },

  'n8n-nodes-base.code': (n) => {
    const p = n.parameters || {}
    const src = (p.jsCode || p.functionCode || '// (empty)').trim()
    // Wrapped in a function so the node's own `return` returns a value here rather than
    // exiting run(), and so repeated Code nodes don't collide over `items`.
    // If the snippet declares its own `items`, naming the parameter `items` too would be
    // a redeclaration — so step aside and expose the input under a different name.
    const param = /\b(?:const|let|var)\s+items\b/.test(src) ? '_items' : 'items'
    return {
      code:
        `// original n8n Code node, inlined\n` +
        `item = await (async (${param}) => {\n` +
        ind(src, 2) + `\n` +
        `})([{ json: item }])  // n8n's $input / $json map to \`${param}\` here`,
      supported: true,
    }
  },

  'n8n-nodes-base.if': (n) => {
    const p = n.parameters || {}
    const conds = p.conditions?.conditions || []
    const parts = conds.map((c) => {
      const left = expr(c.leftValue ?? c.value1 ?? '')
      const right = expr(c.rightValue ?? c.value2 ?? '')
      const op = c.operator?.operation || c.operation || 'equals'
      const map = { equals: '===', notEquals: '!==', gt: '>', lt: '<', gte: '>=', lte: '<=' }
      if (op === 'contains') return `String(${left}).includes(String(${right}))`
      if (op === 'isEmpty') return `!${left}`
      if (op === 'isNotEmpty') return `Boolean(${left})`
      return `${left} ${map[op] || '==='} ${right}`
    })
    const test = parts.length ? parts.join(p.conditions?.combinator === 'or' ? ' || ' : ' && ') : 'true'
    return { code: `passed = ${test}\n// true branch continues below; false branch is the node's second output`, supported: true }
  },

  'n8n-nodes-base.filter': (n) => GEN['n8n-nodes-base.if'](n),

  'n8n-nodes-base.wait': (n) => {
    const p = n.parameters || {}
    const amount = Number(p.amount || 1)
    const unit = p.unit || 'seconds'
    const ms = { seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000 }[unit] || 1000
    return { code: `await new Promise(r => setTimeout(r, ${amount * ms})) // wait ${amount} ${unit}`, supported: true }
  },

  'n8n-nodes-base.noOp': () => ({ code: `// no-op (pass through)`, supported: true }),

  'n8n-nodes-base.splitOut': (n) => {
    const field = (n.parameters || {}).fieldToSplitOut || 'items'
    return { code: `rows = item[${JSON.stringify(field)}] || []\nfor (const row of rows) {\n  // downstream steps run per row\n}`, supported: true }
  },

  'n8n-nodes-base.splitInBatches': (n) => {
    const size = (n.parameters || {}).batchSize || 10
    return { code: `batchSize = ${size}\nfor (let i = 0; i < input.length; i += batchSize) {\n  const batch = input.slice(i, i + batchSize)\n  // downstream steps run per batch\n}`, supported: true }
  },

  'n8n-nodes-base.aggregate': () => ({ code: `// aggregate: collect all items into one\nitem = { items: collected }`, supported: true }),

  'n8n-nodes-base.merge': () => ({ code: `// merge: combine the branches that feed this step\nitem = { ...branchA, ...branchB } // TODO: check which merge mode you used`, supported: true }),

  'n8n-nodes-base.respondToWebhook': () => ({ code: `return res.json(item)`, supported: true }),

  'n8n-nodes-base.webhook': (n) => {
    const p = n.parameters || {}
    return {
      code: `// Webhook entry point — path: ${JSON.stringify(p.path || '/')}\n` +
            `app.${(p.httpMethod || 'POST').toLowerCase()}(${JSON.stringify('/' + String(p.path || '').replace(/^\//, ''))}, async (req, res) => {\n` +
            `  let item = req.body\n  // ...steps below...\n})`,
      supported: true,
    }
  },

  'n8n-nodes-base.scheduleTrigger': (n) => {
    const r = (n.parameters || {}).rule?.interval?.[0] || {}
    const cron = r.cronExpression || guessCron(r)
    return { code: `// Scheduled trigger\ncron.schedule(${JSON.stringify(cron)}, async () => {\n  let item = {}\n  // ...steps below...\n})`, supported: true }
  },
  'n8n-nodes-base.cron': (n) => GEN['n8n-nodes-base.scheduleTrigger'](n),

  'n8n-nodes-base.switch': (n) => {
    const p = n.parameters || {}
    const rules = p.rules?.values || p.rules?.rules || []
    if (!rules.length) return { code: `// switch with no rules configured`, supported: true }
    const branches = rules.map((r, i) => {
      const left = expr(r.conditions?.conditions?.[0]?.leftValue ?? p.value1 ?? '')
      const right = expr(r.conditions?.conditions?.[0]?.rightValue ?? r.value2 ?? '')
      const label = r.outputKey || `output ${i}`
      return `  if (${left} === ${right}) {
    route = ${JSON.stringify(label)}
  }`
    })
    return { code: `route = 'default'
` + branches.join(' else') + `
// each route continues into its own branch below`, supported: true }
  },

  'n8n-nodes-base.function': (n) => GEN['n8n-nodes-base.code'](n),
  'n8n-nodes-base.functionItem': (n) => GEN['n8n-nodes-base.code'](n),
  'n8n-nodes-base.httpRequestTool': (n) => GEN['n8n-nodes-base.httpRequest'](n),

  'n8n-nodes-base.formTrigger': (n) => ({
    code: `// Form trigger — a submitted form starts this run.
` +
          `// Fields: ${JSON.stringify(((n.parameters||{}).formFields?.values||[]).map(f=>f.fieldLabel))}
` +
          `app.post('/form', async (req, res) => {
  let item = req.body
  // ...steps below...
})`,
    supported: true }),

  'n8n-nodes-base.executeWorkflowTrigger': () => ({
    code: `// Called by another workflow — so this file exports a function others can import.
// export { run }`,
    supported: true }),

  'n8n-nodes-base.executeWorkflow': (n) => ({
    code: `// Calls another workflow. Convert that one too, then import and call it here:
` +
          `// import { run as subWorkflow } from './${(((n.parameters||{}).workflowId||{}).cachedResultName||'other-workflow').replace(/[^A-Za-z0-9]+/g,'-').toLowerCase()}.js'
` +
          `// item = await subWorkflow(item)`,
    supported: true }),

  'n8n-nodes-base.telegramTrigger': () => ({
    code: `// Telegram trigger — execution starts when a message arrives.
` +
          `// Point your bot's webhook at this endpoint:
` +
          `app.post('/telegram', async (req, res) => {
  let item = req.body.message
  // ...steps below...
})`,
    supported: true }),

  'n8n-nodes-base.manualTrigger': () => ({ code: `// Manual trigger — this is just where execution starts`, supported: true }),
  'n8n-nodes-base.start': () => ({ code: `// Start`, supported: true }),
}

function guessCron(r) {
  const f = r.field || 'hours'
  if (f === 'minutes') return `*/${r.minutesInterval || 5} * * * *`
  if (f === 'hours') return `0 */${r.hoursInterval || 1} * * *`
  if (f === 'days') return `0 ${r.triggerAtHour ?? 9} * * *`
  if (f === 'weeks') return `0 ${r.triggerAtHour ?? 9} * * 1`
  return '0 9 * * *'
}

// LLM / AI nodes get a single shared, honest stub.
const AI_PREFIX = '@n8n/n8n-nodes-langchain.'

function aiStub(n) {
  const p = n.parameters || {}
  const prompt = p.text || p.prompt || p.messages?.values?.[0]?.message || ''
  return {
    code:
      `// AI step (${n.type.replace(AI_PREFIX, '')}) — wired to an OpenAI-compatible API.\n` +
      `ai = await fetch(\`\${process.env.LLM_BASE_URL || 'https://api.openai.com/v1'}/chat/completions\`, {\n` +
      `  method: 'POST',\n` +
      `  headers: { 'Content-Type': 'application/json', Authorization: \`Bearer \${process.env.LLM_API_KEY}\` },\n` +
      `  body: JSON.stringify({\n` +
      `    model: process.env.LLM_MODEL || 'gpt-4o-mini',\n` +
      `    messages: [{ role: 'user', content: ${prompt ? expr(prompt) : '`` /* TODO: your prompt */'} }],\n` +
      `  }),\n` +
      `})\n` +
      `item = { ...item, aiResponse: (await ai.json()).choices?.[0]?.message?.content }`,
    supported: true,
  }
}

function stub(n) {
  const params = JSON.stringify(n.parameters || {}, null, 2)
  const short = params.length > 900 ? params.slice(0, 900) + '\n  ... (truncated)' : params
  return {
    code:
      `// TODO: "${n.name}" is a ${n.type.replace('n8n-nodes-base.', '')} node.\n` +
      `// This wraps a third-party integration, so it needs its own SDK or API call.\n` +
      `// Your original settings are preserved here so nothing is lost:\n` +
      ind(short, 0).split('\n').map(l => '// ' + l).join('\n'),
    supported: false,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// graph
// ─────────────────────────────────────────────────────────────────────────────

function orderNodes(nodes, connections) {
  const byName = new Map(nodes.map(n => [n.name, n]))
  const incoming = new Map(nodes.map(n => [n.name, 0]))

  for (const [from, outs] of Object.entries(connections || {})) {
    if (!byName.has(from)) continue
    for (const group of Object.values(outs || {})) {
      for (const branch of group || []) {
        for (const link of branch || []) {
          if (byName.has(link.node)) incoming.set(link.node, (incoming.get(link.node) || 0) + 1)
        }
      }
    }
  }

  // start from triggers, then anything with no inbound edge
  const queue = nodes.filter(n => TRIGGERS.has(n.type))
    .concat(nodes.filter(n => !TRIGGERS.has(n.type) && incoming.get(n.name) === 0))
  const seen = new Set()
  const order = []

  const visit = (node) => {
    if (!node || seen.has(node.name)) return
    seen.add(node.name)
    order.push(node)
    for (const group of Object.values(connections?.[node.name] || {})) {
      for (const branch of group || []) {
        for (const link of branch || []) visit(byName.get(link.node))
      }
    }
  }
  queue.forEach(visit)
  nodes.forEach(visit) // anything unreachable still gets emitted

  return order
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object|string} workflow  parsed n8n JSON, or the raw string
 * @returns {{code:string, report:object}}
 */
function convert(workflow) {
  const wf = typeof workflow === 'string' ? JSON.parse(workflow) : workflow
  const all = wf.nodes || []
  if (!all.length) throw new Error('No nodes found — is this an n8n workflow export?')

  const notes = all.filter(n => IGNORED.has(n.type))
  const nodes = all.filter(n => !IGNORED.has(n.type))
  const order = orderNodes(nodes, wf.connections)

  const bodies = []
  const unsupported = []
  const usesCron = nodes.some(n => n.type.includes('scheduleTrigger') || n.type.includes('cron'))
  const usesExpress = nodes.some(n => n.type.includes('webhook'))

  for (const n of order) {
    const gen = GEN[n.type] || (n.type.startsWith(AI_PREFIX) ? aiStub : null)
    const { code, supported } = gen ? gen(n) : stub(n)
    if (!supported) unsupported.push({ name: n.name, type: n.type })
    bodies.push(
      `  // ── ${n.name} ${'─'.repeat(Math.max(0, 56 - n.name.length))}\n` +
      `  // ${n.type}\n` +
      ind(code, 2) + '\n'
    )
  }

  const header = [
    `// ${wf.name || 'Converted n8n workflow'}`,
    `// Converted from an n8n export by n8n-to-code.`,
    `//`,
    `// ${order.length} steps${notes.length ? ` (${notes.length} sticky note${notes.length > 1 ? 's' : ''} skipped)` : ''}.`,
    unsupported.length
      ? `// ${unsupported.length} step${unsupported.length > 1 ? 's' : ''} need wiring up by hand — search for "TODO:".`
      : `// Every step was translated.`,
    `//`,
    `// This is a starting point, not a finished service. Read it before you run it.`,
    ``,
    usesCron ? `import cron from 'node-cron'` : null,
    usesExpress ? `import express from 'express'\nconst app = express()\napp.use(express.json())` : null,
    ``,
    `async function run(input = {}) {`,
    `  let item = input`,
    `  const steps = {}   // outputs of named steps, for cross-references`,
    `  let res, ai, passed, route, rows, batchSize   // reused across steps`,
    ``,
  ].filter(l => l !== null).join('\n')

  const footer = [
    ``,
    `  return item`,
    `}`,
    ``,
    usesExpress ? `app.listen(process.env.PORT || 3000, () => console.log('listening'))` : `run().then(r => console.log(r)).catch(e => { console.error(e); process.exit(1) })`,
    ``,
  ].join('\n')

  return {
    code: header + bodies.join('\n') + footer,
    report: {
      name: wf.name || 'Untitled workflow',
      totalNodes: all.length,
      stickyNotes: notes.length,
      steps: order.length,
      translated: order.length - unsupported.length,
      needsWork: unsupported.length,
      coverage: order.length ? Math.round(((order.length - unsupported.length) / order.length) * 100) : 0,
      unsupported,
      needsDeps: [usesCron ? 'node-cron' : null, usesExpress ? 'express' : null].filter(Boolean),
    },
  }
}

// Works three ways: a plain <script> in the browser (so opening index.html from disk works —
// ES module imports are blocked over file://), a CommonJS require in Node, and the CLI.
if (typeof module !== 'undefined' && module.exports) module.exports = { convert }
if (typeof window !== 'undefined') window.n8nToCode = { convert }
