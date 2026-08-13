export function collectOdwWorkflows(parentSessionID, children, statusOf, messagesOf) {
  const workflows = new Map();
  for (const child of children ?? []) {
    const metadata = child?.metadata ?? {};
    if (child?.parentID !== parentSessionID || metadata.odw !== true) continue;
    if (metadata.odwParentSessionID && metadata.odwParentSessionID !== parentSessionID) continue;
    const workflowID = string(metadata.odwWorkflowID);
    if (!workflowID) continue;
    let workflow = workflows.get(workflowID);
    if (!workflow) {
      workflow = {
        id: workflowID,
        parentSessionID,
        profile: string(metadata.odwProfile) ?? 'balanced',
        status: 'completed',
        children: [],
        nodes: [],
        startedAt: number(metadata.odwStartedAt) ?? child.time?.created,
        updatedAt: child.time?.updated ?? child.time?.created,
      };
      workflows.set(workflowID, workflow);
    }
    const status = statusOf(child.id)?.type ?? 'idle';
    const messages = messagesOf(child.id) ?? [];
    const assistant = [...messages].reverse().find((message) => message.role === 'assistant');
    const node = {
      sessionID: child.id,
      nodeID: string(metadata.odwNodeID) ?? child.id,
      role: string(metadata.odwRole) ?? 'agent',
      model: modelOf(child, assistant),
      status: nodeStatus(status, assistant),
      durationMs: duration(child, assistant),
      error: assistant?.error ? String(assistant.error?.message ?? assistant.error) : undefined,
    };
    workflow.children.push(child.id);
    workflow.nodes.push(node);
    if (node.status === 'running' || node.status === 'retrying') workflow.status = 'running';
    else if (node.status === 'error' && workflow.status !== 'running') workflow.status = 'failed';
    workflow.updatedAt = Math.max(workflow.updatedAt ?? 0, child.time?.updated ?? assistant?.time?.completed ?? 0);
  }
  return [...workflows.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

function nodeStatus(status, assistant) {
  if (status === 'busy') return 'running';
  if (status === 'retry') return 'retrying';
  if (assistant?.error) return 'error';
  return assistant?.time?.completed ? 'completed' : 'queued';
}

function modelOf(child, assistant) {
  const model = assistant?.model ?? child?.model;
  if (typeof model === 'string') return model;
  if (model?.providerID && model?.modelID) return `${model.providerID}/${model.modelID}`;
  return undefined;
}

function duration(child, assistant) {
  const start = child.time?.created ?? assistant?.time?.created;
  const end = assistant?.time?.completed ?? child.time?.updated;
  return start && end ? Math.max(0, end - start) : undefined;
}

function string(value) {
  return typeof value === 'string' && value.length ? value : undefined;
}

function number(value) {
  return Number.isFinite(value) ? value : undefined;
}

export function controlCommand(workflowID, action) {
  if (!/^odw_[a-f0-9]+$/.test(workflowID)) throw new Error('invalid ODW workflow id');
  if (!['pause', 'resume', 'stop', 'replay', 'skip'].includes(action)) throw new Error('invalid ODW control action');
  return { command: 'odw-control', arguments: `${workflowID} ${action}` };
}
