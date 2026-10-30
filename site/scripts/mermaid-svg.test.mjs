import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mermaidAlt } from './lib/mermaid-svg.mjs';

test('mermaidAlt names the diagram type and its participants', () => {
  const seq = 'sequenceDiagram\n  participant A as Agent\n  participant P as proxy<br/>(plugin)\n  participant S\n  A->>P: hi';
  assert.equal(mermaidAlt(seq), 'Sequence diagram: Agent, proxy, S');
});

test('mermaidAlt lists flowchart node labels, escaped, capped at eight', () => {
  assert.equal(mermaidAlt('flowchart LR\n  A["<b>Agent</b><br/>x"] --> B[(Store <db>)]\n  B -- no --> A'), 'Flowchart: Agent, Store &lt;db&gt;');
  const many = `flowchart TB\n${Array.from({ length: 10 }, (_, i) => `  N${i}[n${i}]`).join('\n')}`;
  assert.match(mermaidAlt(many), /^Flowchart: n0, .*n7, …$/);
  assert.equal(mermaidAlt('pie\n  "a": 1'), 'Diagram');
});
