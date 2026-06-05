/**
 * Codebase migration — pipeline topology (convert → check → fix), no barrier
 * between stages: file A can be in stage 3 while file B is still in stage 1.
 *
 * NOTE: mutates files. Either run through a platform plugin that mediates
 * approvals, or explicitly remove "write_file" from safety.requireApprovalFor.
 * Run: odw-daemon run --script examples/workflows/migrate-to-typescript.js --cwd <your-project>
 */

async function execute(context) {
  phase('Discovery', { estimatedAgents: 1 });
  const files = await context.tools.glob('src/**/*.js');
  log(`Migrating ${files.length} files to TypeScript`);
  await checkpoint({ phase: 'discovery', files });

  phase('Migrate', { estimatedAgents: files.length });
  const results = await pipeline(files, [
    // Stage 1: read + convert
    async (file) => {
      const source = await context.tools.read_file(file);
      const conversion = await agent({
        role: 'typescript-migrator',
        prompt:
          `Convert this JavaScript file to TypeScript. File: ${file}\n\`\`\`js\n${String(source).slice(0, 20000)}\n\`\`\`\n` +
          `Return JSON: {"outputFile": string (same path with .ts), "code": string (the full TypeScript), "typesAdded": number}`,
        schema: {
          type: 'object',
          properties: { outputFile: { type: 'string' }, code: { type: 'string' }, typesAdded: { type: 'number' } },
          required: ['outputFile', 'code'],
        },
        maxTokens: 8000,
      });
      return { file, ...conversion };
    },
    // Stage 2: review the conversion before anything touches disk
    async (converted) => {
      const review = await agent({
        role: 'migration-reviewer',
        prompt:
          `Review this JS→TS conversion for correctness (types, imports, semantics preserved). ` +
          `Original: ${converted.file}. Converted code:\n${String(converted.code).slice(0, 20000)}\n` +
          `Return JSON: {"approved": boolean, "issues": [string]}`,
        schema: {
          type: 'object',
          properties: { approved: { type: 'boolean' }, issues: { type: 'array' } },
          required: ['approved'],
        },
        maxTokens: 4000,
      });
      return { ...converted, approved: review.approved, issues: review.issues ?? [] };
    },
    // Stage 3: write only approved conversions (approval-gated by safety config)
    async (reviewed) => {
      if (!reviewed.approved) {
        log(`skipped ${reviewed.file}: ${reviewed.issues.join('; ')}`, 'warn');
        return { file: reviewed.file, written: false, issues: reviewed.issues };
      }
      await context.tools.write_file(reviewed.outputFile, reviewed.code);
      return { file: reviewed.file, written: true, outputFile: reviewed.outputFile };
    },
  ]);
  await checkpoint({ phase: 'migrate', results });

  phase('Synthesis', { estimatedAgents: 0 });
  const ok = results.filter((r) => r && r.written).length;
  const skipped = results.filter((r) => r && !r.written).length;
  return { migrated: ok, skipped, failed: results.filter((r) => !r).length, details: results };
}

module.exports = { execute };
