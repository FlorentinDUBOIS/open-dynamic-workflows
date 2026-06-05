/**
 * Security audit — MapReduce + adversarial verification.
 * Run: odw-daemon run --script examples/workflows/security-audit.js --cwd <your-project>
 */

async function execute(context) {
  // ─── Discovery ───
  phase('Discovery', { estimatedAgents: 1 });
  const files = await context.tools.glob('src/**/*.{js,ts}');
  log(`Discovered ${files.length} source files`);
  await checkpoint({ phase: 'discovery', files });

  // ─── Parallel audit (map) ───
  phase('Audit', { estimatedAgents: files.length });
  const findings = await parallel(
    files.map((file) => () =>
      agent({
        role: 'security-auditor',
        prompt:
          `Check ${file} for missing authentication, injection risks, and secret leakage. ` +
          `Return JSON: {"file": string, "findings": [{"line": number, "severity": "low"|"medium"|"high"|"critical", "description": string}], "confidence": number}`,
        schema: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            findings: { type: 'array' },
            confidence: { type: 'number' },
          },
          required: ['findings', 'confidence'],
        },
        tools: ['read_file'],
        maxTokens: 4000,
      })
    ),
    { maxConcurrency: context.strategy.concurrency.max }
  );
  await checkpoint({ phase: 'audit', findings });

  // ─── Adversarial verification ───
  phase('Verification', { estimatedAgents: 3 });
  const verified = await verify({
    target: findings,
    mode: 'adversarial',
    critics: [
      { role: 'false-positive-hunter', prompt: 'Find false positives in these security findings. Assume a fifth are wrong.' },
      { role: 'severity-validator', prompt: 'Challenge every severity rating in these findings.' },
      { role: 'completeness-checker', prompt: 'What security issues are MISSING from these findings?' },
    ],
    consensusThreshold: 2,
    minConfidence: 0.8,
  });
  await checkpoint({ phase: 'verification', verified });

  // ─── Synthesis ───
  phase('Synthesis', { estimatedAgents: 1 });
  return agent({
    role: 'report-writer',
    prompt:
      `Write a security audit report from these verified findings: ${JSON.stringify(verified).slice(0, 30000)} ` +
      `Return JSON: {"summary": string, "criticalCount": number, "recommendations": [{"priority": number, "description": string}]}`,
    schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        criticalCount: { type: 'number' },
        recommendations: { type: 'array' },
      },
      required: ['summary', 'recommendations'],
    },
    maxTokens: 8000,
  });
}

module.exports = { execute };
