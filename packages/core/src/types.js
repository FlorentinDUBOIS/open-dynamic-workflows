/**
 * Canonical type definitions for open-dynamic-workflows.
 * These JSDoc typedefs are the strict-type contract shared by every package.
 * Source of truth: architecture/data_contracts.md
 */

/**
 * @typedef {"low"|"medium"|"high"|"massive"} Complexity
 * @typedef {"discovery"|"analysis"|"mutation"|"verification"|"synthesis"} TaskType
 * @typedef {"mapreduce"|"pipeline"|"adversarial"|"consensus"|"treesearch"|"hybrid"} Topology
 * @typedef {"read_file"|"write_file"|"run_bash"|"search"|"git"|"glob"} ToolName
 */

/**
 * @typedef {object} TaskNode
 * @property {string} id
 * @property {string} description
 * @property {TaskType} type
 * @property {string[]} dependencies      node ids that must complete first
 * @property {boolean} parallelizable
 * @property {string} [fanoutSource]      array reference to iterate when parallelizable
 * @property {string} role                AgentRole.id
 * @property {object} expectedOutputSchema JSON Schema
 * @property {number} estimatedTokens
 */

/**
 * @typedef {object} TaskGraph
 * @property {{id: "root", prompt: string, complexity: Complexity,
 *            estimatedTotalAgents: number, estimatedCostUSD: number,
 *            estimatedDurationMinutes: number}} root
 * @property {TaskNode[]} tasks
 */

/**
 * @typedef {object} AgentRole
 * @property {string} id
 * @property {string} title
 * @property {string} systemPrompt
 * @property {ToolName[]} allowedTools
 * @property {string} [model]
 * @property {number} temperature
 * @property {number} maxTokens
 * @property {object} outputSchema        JSON Schema
 */

/**
 * @typedef {object} ExecutionStrategy
 * @property {{max: number, default: number}} concurrency
 * @property {{intervalSeconds: number, onPhaseComplete: boolean}} checkpoint
 * @property {{maxAttempts: number, backoff: "exponential"|"linear", retryableErrors: string[]}} retry
 * @property {{maxTokens: number, maxCostUSD: number, alertAtPercent: number, model: string}} budget
 * @property {{perAgent: number, perPhase: number, total: number}} timeouts
 * @property {{requireApprovalFor: ToolName[], autoApproveReadOnly: boolean, dryRun: boolean}} safety
 * @property {{createBranch: boolean, branchPrefix: string, commitCheckpoints: boolean}} git
 */

/**
 * @typedef {object} Plan
 * @property {string} planId
 * @property {string} prompt
 * @property {TaskGraph} taskGraph
 * @property {Topology} topology
 * @property {AgentRole[]} roles
 * @property {ExecutionStrategy} strategy
 * @property {string} script              generated `async function execute(context)` source
 * @property {{totalAgents: number, maxConcurrent: number, tokens: number, costUSD: number, minutes: number}} estimate
 * @property {string} createdAt           ISO timestamp
 */

/**
 * @typedef {object} TriggerResult
 * @property {boolean} triggered
 * @property {"workflow"|"ultracode"|"deep-research"|null} mode
 * @property {string} cleanPrompt
 */

/**
 * @typedef {object} AgentResult
 * @property {*} output
 * @property {number} tokensInput
 * @property {number} tokensOutput
 * @property {number} costUSD
 * @property {number} durationMs
 */

export {};
