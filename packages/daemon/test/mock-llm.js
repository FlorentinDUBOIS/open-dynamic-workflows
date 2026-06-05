/**
 * Mock LLM provider fixture — a real HTTP server emulating the OpenAI
 * chat-completions wire format (the daemon routes arbitrary models there via
 * baseURLs.default). Responses are deterministic and keyed off prompt markers
 * so generated orchestration scripts execute end-to-end with zero cost.
 */

import http from 'node:http';

/**
 * @param {{behavior?: (prompt: string, body: object) => object|string,
 *          failFor?: (prompt: string) => boolean,
 *          latencyMs?: number}} [options]
 * @returns {Promise<{url: string, port: number, calls: Array<{model: string, prompt: string}>, close: () => Promise<void>}>}
 */
export async function startMockLLM(options = {}) {
  const calls = [];

  // NOTE: order matters — generated prompts embed upstream JSON as context, so
  // anchor on phrases unique to each prompt's INSTRUCTION (which comes first),
  // and match synthesis/critic before the broad analysis patterns.
  const defaultBehavior = (prompt) => {
    const instruction = prompt.split(' Context: ')[0].split(' Findings to review: ')[0];
    if (/Merge verified results|final deliverable/i.test(instruction)) {
      return { summary: 'mock synthesis of all results', details: ['detail-1', 'detail-2'] };
    }
    if (/Findings to review:/.test(prompt)) {
      return { approved: true, confidence: 0.95, critique: 'mock critique: looks right', rejectedItems: [] };
    }
    if (/Enumerate|enumerate the concrete targets/i.test(instruction)) {
      return { items: ['alpha.js', 'beta.js', 'gamma.js'] };
    }
    if (/Analyze ONE|Apply the requested change/i.test(instruction)) {
      return { findings: [{ line: 1, severity: 'low', description: 'mock finding' }], confidence: 0.9, changed: true, summary: 'mock change' };
    }
    return { result: 'ok' };
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', async () => {
      if (options.latencyMs) await new Promise((r) => setTimeout(r, options.latencyMs));
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        /* tolerate */
      }
      const prompt = body.messages?.filter((m) => m.role === 'user').map((m) => m.content).join('\n') ?? '';
      calls.push({ model: body.model, prompt });

      if (options.failFor?.(prompt)) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock provider failure' } }));
        return;
      }

      const behavior = options.behavior ?? defaultBehavior;
      const output = behavior(prompt, body);
      const content = typeof output === 'string' ? output : JSON.stringify(output);

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'mock-1',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          model: body.model,
        })
      );
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
