/**
 * Studio Prime — autonomous 6-phase product pipeline, expressed as an
 * Open Dynamic Workflows (ODW) orchestration template.
 *
 * The model writes this script once; the ODW daemon runs it. Each phase
 * gates the next through an adversarial "Apex Red Team" verification step,
 * with bounded remediation, checkpointing, and a final North Star validation.
 *
 * Run it with the ODW daemon:
 *   odw-daemon run --script studio-prime.workflow.js --cwd <your-project>
 *
 * The brief / North Star is read (in order) from:
 *   args().northstar  →  args().brief  →  a PRD file in the project dir
 *   (northstar.md / NORTHSTAR.md / prd.md / PRD.md / brief.md)  →  a default.
 *
 * Primitives used (provided by the ODW sandbox): agent, parallel, verify,
 * loop, phase, log, checkpoint, budget, args, context.tools.
 */

// ── phase definitions ─────────────────────────────────────────────────────────
// Each phase: a specialist role, a structured artifact schema, the research
// questions for its (mandatory) research gate, and the focus the Apex Red Team
// reviews against. This mirrors Studio Prime's P1–P6 lifecycle.
const PHASES = [
  {
    id: 'blueprint',
    title: 'P1 Blueprint',
    role: 'principal-architect',
    focus: 'architecture soundness, PRD alignment, security baseline',
    research: ['best architecture and stack for this goal', 'supply-chain and security baseline', 'key library and dependency choices'],
    schema: { decisions: 'array', dataContracts: 'array', designSystem: 'object', risks: 'array' },
    instruction: 'Establish the blueprint: pinned stack, architecture decisions with rationale, data contracts (schemas/APIs), a design-system sketch, and the top risks.',
  },
  {
    id: 'link',
    title: 'P2 Link',
    role: 'integration-architect',
    focus: 'integration seams, credentials, data-contract completeness',
    research: ['integration patterns for the chosen stack', 'auth and identity flows', 'deployment target options'],
    schema: { moduleBoundaries: 'array', integrationSeams: 'array', authWiring: 'object', deploymentTarget: 'string' },
    instruction: 'Convert the blueprint into an executable integration plan: module boundaries, integration seams, auth wiring, and a locked deployment target.',
  },
  {
    id: 'architecture',
    title: 'P3 Architecture',
    role: 'scaffolding-engineer',
    focus: 'strict types, test scaffolding validity, infra correctness',
    research: ['framework conventions and project layout', 'test-runner and coverage setup', 'CI/CD and container scaffolding'],
    schema: { interfaces: 'array', types: 'array', testStubs: 'array', ciPipeline: 'object', migrations: 'array' },
    instruction: 'Scaffold interfaces, strict types, passing test stubs (no business logic yet), CI pipeline, and migration setup. List the exact files to create.',
  },
  {
    id: 'implement',
    title: 'P4 Implement',
    role: 'implementation-engineer',
    focus: 'logic correctness, 80%+ coverage, security hardening',
    research: ['library APIs needed for the features', 'security advisories for the stack', 'performance gotchas'],
    schema: { modules: 'array', coverageTarget: 'number', securityHardening: 'array', openIssues: 'array' },
    instruction: 'Fill in the business logic and make the test suite pass. Enumerate each module, the security hardening applied, and any open issues. (Note: deep multi-step code authoring is driven through context.tools.write_file / run_bash — see setup.md.)',
  },
  {
    id: 'stylize',
    title: 'P5 Stylize',
    role: 'ux-engineer',
    focus: 'design correctness, WCAG 2.1 AA accessibility, no anti-patterns',
    research: ['current WCAG 2.1 AA requirements', 'modern design tokens and motion', 'accessibility audit tooling'],
    schema: { designTokens: 'object', componentStates: 'array', accessibility: 'object' },
    instruction: 'Apply the design standard: OKLCH tokens, a full component-state matrix (default/hover/focus/active/disabled), and an accessibility pass. Report any violations.',
  },
  {
    id: 'release',
    title: 'P6 Release',
    role: 'release-engineer',
    focus: 'release safety, smoke coverage, rollback readiness, handoff completeness',
    research: ['deployment target documentation', 'monitoring and alerting integrations', 'secrets management for the target'],
    schema: { deployPlan: 'object', smokeTests: 'array', rollback: 'object', handoff: 'object' },
    instruction: 'Produce the release: build + deploy plan, smoke tests for every critical path, an executable rollback, and a complete handoff document outline.',
  },
];

// ── Apex Red Team gate (adversarial verification) ───────────────────────────────
function apexReview(ph, artifact, northstar) {
  return verify({
    target: { phase: ph.title, focus: ph.focus, northstar: String(northstar).slice(0, 1200), artifact },
    mode: 'adversarial',
    critics: [
      { role: 'steelman-then-skeptic', prompt: 'First steelman this ' + ph.title + ' artifact, then attack it hard. Approve ONLY if you find no blocking flaw against the goal.' },
      { role: 'zero-trust-auditor', prompt: 'You are a zero-trust auditor told there IS a critical security or architectural flaw in this ' + ph.title + ' artifact. Find it; you cannot conclude "none".' },
      { role: 'completeness-checker', prompt: 'What REQUIRED element is missing for: ' + ph.focus + '? If something essential is absent, reject.' },
    ],
    consensusThreshold: 2,
    minConfidence: 0.6,
  });
}

// ── one phase: research gate → produce artifact → Apex gate → bounded remediation ─
async function runPhase(context, ph, state) {
  phase(ph.title, { focus: ph.focus });

  // 1. Mandatory research gate (parallel; failures are tolerated).
  log(ph.title + ': research gate (' + ph.research.length + ' questions)');
  const research = (await parallel(
    ph.research.map((q) => () =>
      agent({
        role: 'researcher',
        prompt: 'Research question for ' + ph.title + ': ' + q + '. Project goal: ' + String(state.northstar).slice(0, 600) +
          '. Return concise findings and any assumption updates.',
        schema: { findings: 'array', assumptionUpdates: 'array' },
        maxTokens: 1500,
      }).catch((e) => ({ __odw_failed: true, error: String(e && e.message || e) }))
    ),
    { maxConcurrency: 4 }
  )).filter((r) => r && !r.__odw_failed);

  const buildPrompt = (extra) =>
    'You are the ' + ph.role + ' for this phase. ' + ph.instruction +
    '\nProject North Star: ' + String(state.northstar).slice(0, 1500) +
    '\nResearch findings: ' + JSON.stringify(research).slice(0, 4000) +
    '\nPrior phases: ' + JSON.stringify(Object.keys(state.artifacts)) +
    (extra || '') +
    '\nReturn ONLY the structured artifact.';

  // 2. Produce the phase artifact.
  let artifact = await agent({ role: ph.role, prompt: buildPrompt(''), schema: ph.schema, maxTokens: 4000 });

  // 3. Apex Red Team gate, with bounded remediation (Studio Prime's 3-tier verdict
  //    collapses to: passed = GREEN_FLAG/TECH_DEBT (proceed); not passed = BLOCKER).
  let verdict = await apexReview(ph, artifact, state.northstar);
  let cycle = 0;
  const MAX_REMEDIATION = 2;
  while (!verdict.passed && cycle < MAX_REMEDIATION) {
    cycle++;
    log(ph.title + ': BLOCKER verdict — remediation cycle ' + cycle + '/' + MAX_REMEDIATION, 'warn');
    const critiques = JSON.stringify((verdict.verdicts || []).map((v) => v && v.critique).filter(Boolean)).slice(0, 2000);
    artifact = await agent({ role: ph.role, prompt: buildPrompt('\nRESOLVE these blocking critiques from review: ' + critiques), schema: ph.schema, maxTokens: 4000 });
    verdict = await apexReview(ph, artifact, state.northstar);
  }

  const status = verdict.passed ? 'GREEN_FLAG/TECH_DEBT' : 'BLOCKER (deferred after remediation cap)';
  log(ph.title + ': ' + status + (cycle ? ' after ' + cycle + ' remediation cycle(s)' : ''));

  state.artifacts[ph.id] = artifact;
  state.verdicts[ph.id] = { passed: verdict.passed, status, approvals: verdict.approvals, rejections: verdict.rejections };

  // 4. Checkpoint — the daemon's SQLite/WAL store makes this resumable on crash.
  await checkpoint({ phase: ph.id, artifact, verdict: state.verdicts[ph.id] });
  return artifact;
}

// ── the pipeline ────────────────────────────────────────────────────────────────
async function execute(context) {
  const a = args() || {};
  let northstar = a.northstar || a.brief || '';
  if (!northstar) {
    for (const file of ['northstar.md', 'NORTHSTAR.md', 'prd.md', 'PRD.md', 'brief.md']) {
      try {
        const text = await context.tools.read_file(file);
        if (text && String(text).trim()) { northstar = text; log('North Star loaded from ' + file); break; }
      } catch { /* try next file */ }
    }
  }
  if (!northstar) {
    northstar = 'No brief was provided. Design and build a small, well-tested, well-documented utility that is clearly useful for this repository, then ship it.';
    log('No brief found — proceeding with a safe default North Star', 'warn');
  }

  log('Studio Prime pipeline starting: 6 phases, adversarial gate per phase');
  const state = { northstar, artifacts: {}, verdicts: {} };

  for (const ph of PHASES) {
    await runPhase(context, ph, state);
  }

  // ── North Star validation gate ──────────────────────────────────────────────
  phase('North Star Validation', {});
  const validation = await agent({
    role: 'northstar-validator',
    prompt: 'Compare every North Star requirement against the produced phase artifacts and classify each as MET / PARTIALLY_MET / NOT_MET, with a one-line reason.' +
      '\nNorth Star: ' + String(northstar).slice(0, 2000) +
      '\nArtifacts: ' + JSON.stringify(state.artifacts).slice(0, 12000) +
      '\nReturn the structured validation.',
    schema: { requirements: 'array', overall: 'string', gaps: 'array' },
    maxTokens: 4000,
  });
  await checkpoint({ phase: 'northstar-validation', validation });

  const blocked = Object.entries(state.verdicts).filter(([, v]) => !v.passed).map(([k]) => k);
  return {
    summary: 'Studio Prime pipeline complete across ' + PHASES.length + ' phases.',
    phases: state.verdicts,
    unresolvedBlockers: blocked,
    northstarValidation: validation,
    artifacts: state.artifacts,
  };
}

module.exports = { execute };
