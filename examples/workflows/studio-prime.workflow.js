/**
 * Studio Prime — the autonomous 6-phase product pipeline, as a runnable
 * Open Dynamic Workflows script. This does what the Studio Prime prompt does:
 * it RESEARCHES (live web), BUILDS (writes real files), VERIFIES (runs the test
 * suite and loops fix-until-green), reviews each phase with an adversarial Apex
 * Red Team, and leaves a WORKING product behind — not just a plan.
 *
 *   odw-daemon run --script examples/workflows/studio-prime.workflow.js --cwd <project>
 *
 * To let it build autonomously it must be allowed to write files and run the
 * test command, so run it with `safety.requireApprovalFor: []` in the config.
 * Target: a zero-dependency Node project (node:test) — the most reliably
 * buildable shape; the brief can ask for anything expressible that way.
 *
 * Brief / North Star: args().northstar → a PRD file in cwd → a default.
 *
 * CONTEXT-SAFE BY DESIGN: every artifact fed forward between phases goes through
 * compact() (structure-preserving, never mid-JSON slicing) and research is
 * condensed with summarize() (semantic map-reduce), so the pipeline survives on
 * small/free models where a blind truncation would corrupt the next prompt. The
 * engine's own pre-call context guard compacts oversized prompts as a backstop.
 */

// ── adversarial Apex Red Team gate (steelman → attack → completeness) ────────────
function apexReview(title, focus, artifact, northstar) {
  // compact() keeps the artifact structurally valid under the budget instead of
  // a blind clip() that could feed the critics half-parsed JSON.
  return compact(artifact, { maxChars: 6000 }).then(function (slim) {
    return verify({
      target: { phase: title, focus: focus, northstar: String(northstar).slice(0, 1200), artifact: slim },
      mode: 'adversarial',
      maxChars: 24000,
      critics: [
        { role: 'steelman-then-skeptic', prompt: 'Steelman this ' + title + ' artifact in one line, THEN attack it hard. Approve ONLY if there is no blocking flaw against the stated goal.' },
        { role: 'zero-trust-auditor', prompt: 'You are told there IS a critical correctness or security flaw in this ' + title + ' artifact. Find it concretely; you cannot conclude "none found".' },
        { role: 'completeness-checker', prompt: 'What REQUIRED element is missing for: ' + focus + '? Reject if something essential is absent or stubbed.' },
      ],
      consensusThreshold: 2,
      minConfidence: 0.6,
    });
  });
}

function clip(v, n) { var s = typeof v === 'string' ? v : JSON.stringify(v); return s && s.length > n ? s.slice(0, n) : s; }
function green(out) { return /# fail 0\b/.test(out) && /# pass [1-9]/.test(out); }

async function execute(context) {
  const T = context.tools;
  const a = args() || {};
  let northstar = a.northstar || a.brief || '';
  if (!northstar) {
    for (const f of ['northstar.md', 'NORTHSTAR.md', 'prd.md', 'PRD.md', 'brief.md']) {
      try { const t = await T.read_file(f); if (t && String(t).trim()) { northstar = t; break; } } catch { /* next */ }
    }
  }
  if (!northstar) northstar = 'Build a small, well-tested, zero-dependency Node.js command-line utility that is genuinely useful, with unit tests and an MIT license.';

  const proof = {};           // phase → captured command stdout (proof-of-work)
  const verdicts = {};        // phase → adversarial verdict
  const state = { northstar, files: [], entry: null, testCmd: 'node --test test/' };

  // ── helpers: real research / file writes / command runs ──────────────────────

  // Run all queries in PARALLEL (isolated calls), then condense the combined
  // findings with summarize() into one dense, bounded brief — semantic
  // compression that survives on small models, not a blind character cut.
  async function research(queries) {
    const raw = await parallel(queries.map((q) => async () => {
      try {
        const hits = await T.web_search(q);
        let detail = '';
        if (hits && hits[0] && hits[0].url) { try { detail = (await T.web_fetch(hits[0].url)).text.slice(0, 1800); } catch { /* fetch optional */ } }
        const top = (hits || []).slice(0, 4).map((h) => h.title + ' — ' + h.url).join('; ');
        return 'Q: ' + q + '\n  top: ' + top + (detail ? '\n  detail: ' + detail : '');
      } catch (e) { return 'Q: ' + q + ' (search failed: ' + e.message + ')'; }
    }), { maxConcurrency: 4 });
    // summarize() short-circuits (no model call) when the brief is already small.
    return summarize(raw.join('\n\n'), { maxChars: 2200, instructions: 'Condense these research notes into actionable findings: best practices, gotchas, concrete APIs. Keep names, flags, and file paths verbatim.' });
  }

  // Structure-preserving context for the NEXT prompt — never a mid-JSON cut.
  async function ctx(value, maxChars) { return JSON.stringify(await compact(value, { maxChars: maxChars || 1500 })); }

  async function writeFiles(files) {
    const written = [];
    for (const f of files || []) {
      if (!f || !f.path || typeof f.contents !== 'string') continue;
      try { await T.write_file(f.path, f.contents); written.push(f.path); state.files.push(f.path); }
      catch (e) { log('  write failed ' + f.path + ': ' + e.message, 'warn'); }
    }
    return written;
  }

  async function run(cmd) {
    try { const r = await T.run_bash(cmd); return { ok: !(r && r.failed), stdout: String((r && r.stdout) || '').slice(0, 4000) }; }
    catch (e) { return { ok: false, stdout: String(e.message).slice(0, 4000) }; }
  }

  log('Studio Prime: building toward — ' + String(northstar).slice(0, 160).replace(/\s+/g, ' '));

  // ════ P1 Blueprint ════════════════════════════════════════════════════════════
  phase('P1 Blueprint');
  const r1 = await research(['Node.js project structure best practices 2026', 'node:test built-in test runner usage examples', 'package.json type module ESM minimal setup']);
  const bp = await safeAgent('principal-architect',
    'Plan a zero-dependency Node.js (ESM, "type":"module") project for this goal. ' +
    'Decide the product name and shape. Return files to create now: package.json (with "scripts":{"test":"node --test test/"}, "type":"module", "license":"MIT"), a README.md, and architecture/decisions.md. ' +
    'Goal: ' + clip(northstar, 1200) + '\nResearch findings: ' + clip(r1, 2000),
    { projectName: 'string', entry: 'string', files: [{ path: 'string', contents: 'string' }] });
  if (bp) { state.entry = bp.entry || state.entry; await writeFiles(bp.files); }
  proof.blueprint = { wrote: state.files.slice() };
  verdicts.blueprint = await gate('P1 Blueprint', 'architecture soundness, PRD alignment', bp || {}, northstar);

  // ════ P2 Link ════════════════════════════════════════════════════════════════
  phase('P2 Link');
  const r2 = await research(['module boundaries small Node CLI', 'how to structure unit tests with node:test', 'separating pure logic from IO for testability']);
  const link = await safeAgent('integration-architect',
    'Define module boundaries and the integration plan for the project. Return architecture/integration_plan.md as a file. ' +
    'Goal: ' + clip(northstar, 800) + '\nDecisions so far: ' + (await ctx(bp, 1500)) + '\nResearch: ' + clip(r2, 1500),
    { files: [{ path: 'string', contents: 'string' }] });
  if (link) await writeFiles(link.files);
  verdicts.link = await gate('P2 Link', 'integration seams and contract completeness', link || {}, northstar);

  // ════ P3 Architecture (scaffold + tests, must run) ═════════════════════════════
  phase('P3 Architecture');
  const r3 = await research(['writing failing unit tests first TDD node:test', 'ESM module exports patterns Node', 'node:assert strict usage patterns']);
  const arch = await safeAgent('scaffolding-engineer',
    'Scaffold the implementation files (in src/) with real exported function signatures, and test files (in test/, using node:test and node:assert) that EXERCISE those functions with real assertions. ' +
    'The source may be stubs for now. Set "entry" to the main module path. Goal: ' + clip(northstar, 1000) + '\nPlan: ' + (await ctx(link, 1200)) + '\nResearch: ' + clip(r3, 1200),
    { entry: 'string', files: [{ path: 'string', contents: 'string' }] });
  if (arch) { state.entry = arch.entry || state.entry; await writeFiles(arch.files); }
  const t3 = await run(state.testCmd);
  proof.architecture = { testStdout: t3.stdout.slice(0, 1500) };
  log('P3: scaffold test run — ' + (t3.ok ? 'suite executed' : 'suite errored (expected pre-impl)'));
  verdicts.architecture = await gate('P3 Architecture', 'strict interfaces and a runnable test suite', { files: state.files, testStdout: t3.stdout.slice(0, 800) }, northstar);

  // ════ P4 Implement (hardened fix-until-green loop) ═════════════════════════════
  phase('P4 Implement');
  const r4 = await research(['common Node.js bugs to avoid', 'input validation best practices Node', 'edge cases unit testing CLI tools']);
  let testRun = await run(state.testCmd);
  let pass = green(testRun.stdout);
  let lastSig = '';
  let impl = null;
  for (let cycle = 1; cycle <= 6 && !pass; cycle++) {
    const failOut = testRun.stdout;
    const sig = failOut.replace(/\d+(\.\d+)?ms/g, '').slice(0, 200); // ignore timing jitter
    const repeated = sig === lastSig;
    lastSig = sig;
    log('P4: implement+test cycle ' + cycle + (repeated ? ' (same failure — switching approach)' : ''), 'warn');
    impl = await safeAgent('implementation-engineer',
      'The test suite is NOT green. FIRST state the root cause in one line, THEN return the COMPLETE updated source files (path + FULL contents) that make EVERY test pass. ' +
      (repeated ? 'Your previous change did NOT alter the failure — take a DIFFERENT approach this time. ' : '') +
      'Do not edit the tests to pass; fix the implementation. Goal: ' + clip(northstar, 900) +
      '\nCurrent failing test output:\n' + clip(failOut, 3000) + '\nResearch: ' + clip(r4, 900),
      { diagnosis: 'string', files: [{ path: 'string', contents: 'string' }], notes: 'string' });

    let wrote = impl && impl.files ? await writeFiles(impl.files) : [];
    // Free/weak-model fallback: multi-file JSON often comes back malformed and
    // parses to zero files. Recover by asking for ONE file's full contents at a
    // time — far more reliable on small models than a big multi-file payload.
    if (!wrote.length && state.entry) {
      log('P4: multi-file reply was empty/malformed — falling back to one-file-at-a-time', 'warn');
      const one = await safeAgent('implementation-engineer',
        'Return ONLY the full contents of the single file "' + state.entry + '" so the tests pass. ' +
        'Goal: ' + clip(northstar, 700) + '\nFailing output:\n' + clip(failOut, 2500),
        { path: 'string', contents: 'string' });
      if (one && typeof one.contents === 'string') wrote = await writeFiles([{ path: one.path || state.entry, contents: one.contents }]);
    }
    if (!wrote.length) break;
    testRun = await run(state.testCmd);
    pass = green(testRun.stdout);
  }
  proof.implement = { passed: pass, testStdout: testRun.stdout.slice(0, 2000) };
  log('P4: tests ' + (pass ? 'GREEN' : 'not green after cycles'));
  verdicts.implement = await gate('P4 Implement', 'all tests pass, logic correct, inputs validated', { passed: pass, testStdout: testRun.stdout.slice(0, 1200) }, northstar);

  // ════ P5 Stylize (docs / UX polish) ════════════════════════════════════════════
  phase('P5 Stylize');
  const r5 = await research(['writing a good CLI --help and README', 'developer experience for small tools', 'clear usage examples documentation']);
  const style = await safeAgent('ux-engineer',
    'Polish the developer experience: a clear README.md (install, usage, examples), and if there is a CLI entry, a --help output. Return updated files. ' +
    'Goal: ' + clip(northstar, 700) + '\nEntry: ' + state.entry + '\nResearch: ' + clip(r5, 800),
    { files: [{ path: 'string', contents: 'string' }] });
  if (style) await writeFiles(style.files);
  verdicts.stylize = await gate('P5 Stylize', 'clear docs and usable developer experience', style || {}, northstar);

  // ════ P6 Release (run it, smoke it, hand off, leave it working) ═════════════════
  phase('P6 Release');
  const finalTest = await run(state.testCmd);
  const finalPass = green(finalTest.stdout);
  // smoke: actually run the product
  let smoke = { ok: false, stdout: '' };
  if (state.entry) { smoke = await run('node ' + state.entry + ' --help'); if (!smoke.ok) smoke = await run('node ' + state.entry); }
  const handoff = await safeAgent('release-engineer',
    'Write HANDOFF.md: what was built, how to run it, how to test it, and any known limitations. Return it as a file. ' +
    'Goal: ' + clip(northstar, 700) + '\nFiles built: ' + (await ctx(state.files, 800)) + '\nTests green: ' + finalPass,
    { files: [{ path: 'string', contents: 'string' }] });
  if (handoff) await writeFiles(handoff.files);
  proof.release = { finalPass, testStdout: finalTest.stdout.slice(0, 1200), smokeOk: smoke.ok, smokeStdout: smoke.stdout.slice(0, 800) };
  verdicts.release = await gate('P6 Release', 'product builds, tests pass, it runs, handoff complete', { finalPass, smokeOk: smoke.ok }, northstar);

  // ════ North Star Validation ════════════════════════════════════════════════════
  phase('North Star Validation');
  let validation;
  try {
    validation = await safeAgent('northstar-validator',
      'Classify each North Star requirement as MET / PARTIALLY_MET / NOT_MET against what was actually built and tested. ' +
      'North Star: ' + clip(northstar, 1500) + '\nFiles: ' + (await ctx(state.files, 800)) + '\nTests green: ' + finalPass + '\nSmoke ran: ' + smoke.ok,
      { requirements: [{ id: 'string', status: 'string', reason: 'string' }], overall: 'string', gaps: ['string'] });
  } catch (e) { validation = { overall: 'UNVALIDATED', gaps: [String(e.message)] }; }
  validation = validation || { overall: 'UNVALIDATED', gaps: [] };

  const blockers = Object.entries(verdicts).filter(([, v]) => !v.passed).map(([k]) => k);
  return {
    summary: 'Studio Prime build complete. Tests ' + (finalPass ? 'GREEN' : 'NOT green') + '; product ' + (smoke.ok ? 'runs' : 'did not smoke') + '.',
    productBuilt: finalPass,
    filesWritten: state.files,
    entry: state.entry,
    proofOfWork: proof,
    phases: verdicts,
    unresolvedBlockers: blockers,
    northstarValidation: validation,
  };

  // ── inner helpers that close over state ──────────────────────────────────────
  async function safeAgent(role, prompt, schema) {
    try { return await agent({ role, prompt, schema, maxTokens: 6000 }); }
    catch (e) { if (e && (e.code === 'aborted' || e.code === 'paused')) throw e; log('  ' + role + ' failed: ' + e.message, 'warn'); return null; }
  }
  async function gate(title, focus, artifact, ns) {
    let v;
    try { v = await apexReview(title, focus, artifact, ns); }
    catch (e) { if (e && (e.code === 'aborted' || e.code === 'paused')) throw e; v = { passed: false, approvals: 0, rejections: 0 }; }
    const status = v.passed ? 'GREEN_FLAG/TECH_DEBT' : 'BLOCKER';
    log(title + ': ' + status);
    await checkpoint({ phase: title, artifact: clip(artifact, 2000), passed: v.passed });
    return { passed: v.passed, status, approvals: v.approvals, rejections: v.rejections };
  }
}

module.exports = { execute };
