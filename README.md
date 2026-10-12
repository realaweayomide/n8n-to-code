# n8n → Code

Paste an n8n workflow export, get readable Node.js.

**[▶ Live demo](https://realaweayomide.github.io/n8n-to-code/)** · built by [Ayomide Awe](https://github.com/realaweayomide)

Runs entirely in your browser — your workflow is never uploaded anywhere.

## Why

I started automating with n8n. It was the right tool to start with: you get a working
automation in an afternoon and you can see the whole flow.

Then the flows got big. And when a 30-step workflow breaks, *you* are the debugger — one step
fails, the error tells you almost nothing, and you walk every box by hand guessing which one
moved. No version history, no way to test one piece in isolation.

So I moved to code. This is the bridge I wanted at the time.

## What it does

| It writes real code for | It leaves a TODO for |
|---|---|
| HTTP requests, Set/transform, Code nodes, IF/Switch/Filter, loops, waits, merges, schedule and webhook triggers, AI/LLM steps | Third-party integrations — Google Sheets, Gmail, Slack, Telegram, Postgres, Drive |

It resolves the node graph into real execution order, translates `{{ $json.x }}` expressions
into template literals, inlines your Code nodes (correctly scoped, so their `return` works),
and skips sticky notes.

Nothing is thrown away: for integrations it can't write, your original parameters are preserved
in comments so you can wire them up without going back to n8n.

## What it is not

It is **not a compiler**. n8n has 600+ node types, many wrapping an entire authenticated SaaS
product. Emitting working code for all of them isn't a realistic goal, and pretending otherwise
would produce confident nonsense.

The goal is narrower and more useful: **turn a canvas you can no longer reason about into a file
you can read.**

## Measured against 5,000 real workflows

I tested this against a library of 4,997 real-world n8n workflows (71,788 nodes):

```
  step coverage            70%   (50,542 / 71,788 steps translated)
  generated code parses    99%   (491 / 497 sampled files are valid JavaScript)
```

The 30% gap is almost entirely SaaS integrations, which is the honest ceiling without writing a
per-service SDK layer. Measuring it is also how I improved it — the first run scored 62%, and the
gap report showed `httpRequestTool` (3,000 uses) was just `httpRequest` in a different wrapper.

## Use it

**Browser:** [the live demo](https://realaweayomide.github.io/n8n-to-code/) — paste or drop a file.

**CLI:**
```bash
node cli.js workflow.json              # print the code
node cli.js workflow.json -o out.js    # write it to a file
node cli.js ./folder --report          # coverage stats across many workflows
```

No dependencies. No build step. `convert.js` is a single module that runs in both the browser
and Node.

**Getting the JSON:** in n8n, open a workflow → `⋯` menu → **Download**.

## How it handles the hard parts

- **Execution order** — depth-first walk of the connection graph from the trigger nodes, so the
  output reads top to bottom in the order things actually run.
- **Expressions** — `{{ $json.x }}` becomes `${item.x}`, `{{ $node["A"].json.y }}` becomes
  `${steps["A"].y}`. If a translation doesn't produce valid JavaScript, it falls back to the
  original as a string with a TODO rather than breaking the whole file.
- **Code nodes** — wrapped in an async IIFE so the snippet's own `return` returns a value
  instead of exiting the function, and repeated Code nodes don't collide.
- **Shared variables** — `res`, `passed`, `route` and friends are hoisted once, because a
  workflow with eight HTTP steps would otherwise redeclare `const res` eight times.

That last one is the sort of thing you only find by generating code for 500 real workflows and
checking whether each one parses. It's why the pass rate went from 55% to 99%.

## License

MIT
