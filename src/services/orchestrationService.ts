/**
 * Agent Orchestration Engine Service.
 *
 * Coordinates complex multi-agent workflows via DAG-based task definitions.
 * Features:
 * - Workflow definition (DAG of tasks with dependencies)
 * - Task execution with retry logic
 * - Parallel and sequential task modes
 * - Workflow state machine (pending → running → completed/failed)
 * - Agent task assignment based on capability
 * - Workflow analytics (execution time, bottleneck detection, success rates)
 */

import { v4 as uuid } from 'uuid';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';
import { eventBus } from '../infra/eventBus.js';
import { isoNow } from '../utils/time.js';

// ─── Types ──────────────────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export type WorkflowStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type TaskMode = 'parallel' | 'sequential';

export interface TaskRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  backoffFactor?: number;
}

export interface TaskDefinition {
  id: string;
  name: string;
  /** IDs of tasks that must complete before this one can start */
  dependsOn: string[];
  /** Agent capability required (e.g. 'trading', 'analysis', 'risk') */
  requiredCapability?: string;
  /** Assigned agent ID (resolved at runtime or manually) */
  assignedAgentId?: string;
  /** Retry policy for this task */
  retryPolicy?: TaskRetryPolicy;
  /** Execution mode when multiple tasks are ready */
  mode?: TaskMode;
  /** Custom payload for the task handler */
  payload?: Record<string, unknown>;
  /** Estimated duration in ms (for analytics) */
  estimatedDurationMs?: number;
}

export interface TaskState {
  taskId: string;
  status: TaskStatus;
  assignedAgentId?: string;
  attempts: number;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  error?: string;
  result?: Record<string, unknown>;
  durationMs?: number;
}

export interface WorkflowDefinition {
  name: string;
  description?: string;
  tasks: TaskDefinition[];
  mode?: TaskMode;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  status: WorkflowStatus;
  tasks: TaskDefinition[];
  taskStates: Map<string, TaskState>;
  mode: TaskMode;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  durationMs?: number;
}

export interface AgentCapability {
  agentId: string;
  capabilities: string[];
  maxConcurrentTasks: number;
  currentTasks: number;
}

export interface WorkflowAnalytics {
  totalWorkflows: number;
  completedWorkflows: number;
  failedWorkflows: number;
  avgDurationMs: number;
  successRate: number;
  bottlenecks: BottleneckInfo[];
  taskSuccessRates: Record<string, number>;
  agentPerformance: AgentPerformanceInfo[];
}

export interface BottleneckInfo {
  taskName: string;
  avgDurationMs: number;
  failureRate: number;
  totalExecutions: number;
}

export interface AgentPerformanceInfo {
  agentId: string;
  tasksCompleted: number;
  tasksFailed: number;
  avgDurationMs: number;
  successRate: number;
}

interface SerializedWorkflow {
  id: string;
  name: string;
  description?: string;
  status: WorkflowStatus;
  tasks: TaskDefinition[];
  taskStates: Record<string, TaskState>;
  mode: TaskMode;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  durationMs?: number;
}

// ─── Service ────────────────────────────────────────────────────────────

export class OrchestrationService {
  private workflows: Map<string, Workflow> = new Map();
  private agentCapabilities: Map<string, AgentCapability> = new Map();
  private taskExecutionHistory: Array<{ taskName: string; durationMs: number; success: boolean; agentId?: string }> = [];

  /**
   * Create a new workflow from a definition.
   * Validates the DAG structure (no cycles, valid dependencies).
   */
  createWorkflow(definition: WorkflowDefinition): SerializedWorkflow {
    if (!definition.tasks || definition.tasks.length === 0) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Workflow must have at least one task.');
    }

    // Validate task IDs are unique
    const taskIds = new Set(definition.tasks.map((t) => t.id));
    if (taskIds.size !== definition.tasks.length) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Task IDs must be unique within a workflow.');
    }

    // Validate dependencies reference existing tasks
    for (const task of definition.tasks) {
      for (const depId of task.dependsOn) {
        if (!taskIds.has(depId)) {
          throw new DomainError(
            ErrorCode.InvalidPayload,
            400,
            `Task '${task.id}' depends on unknown task '${depId}'.`,
          );
        }
      }
      // No self-dependency
      if (task.dependsOn.includes(task.id)) {
        throw new DomainError(ErrorCode.InvalidPayload, 400, `Task '${task.id}' cannot depend on itself.`);
      }
    }

    // Detect cycles via topological sort
    if (this.hasCycle(definition.tasks)) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Workflow contains a dependency cycle.');
    }

    const now = isoNow();
    const taskStates = new Map<string, TaskState>();

    for (const task of definition.tasks) {
      taskStates.set(task.id, {
        taskId: task.id,
        status: 'pending',
        attempts: 0,
      });
    }

    const workflow: Workflow = {
      id: uuid(),
      name: definition.name,
      description: definition.description,
      status: 'pending',
      tasks: definition.tasks,
      taskStates,
      mode: definition.mode ?? 'parallel',
      createdAt: now,
    };

    this.workflows.set(workflow.id, workflow);

    eventBus.emit('orchestration.workflow.created', {
      workflowId: workflow.id,
      name: workflow.name,
      taskCount: workflow.tasks.length,
    });

    return this.serializeWorkflow(workflow);
  }

  /**
   * Start executing a workflow. Resolves agent assignments and begins task execution.
   */
  async startWorkflow(workflowId: string): Promise<SerializedWorkflow> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      throw new DomainError(ErrorCode.InvalidPayload, 404, `Workflow '${workflowId}' not found.`);
    }

    if (workflow.status !== 'pending') {
      throw new DomainError(
        ErrorCode.InvalidPayload,
        400,
        `Workflow is '${workflow.status}', can only start from 'pending'.`,
      );
    }

    workflow.status = 'running';
    workflow.startedAt = isoNow();

    // Resolve agent assignments for tasks that need capabilities
    for (const task of workflow.tasks) {
      if (task.requiredCapability && !task.assignedAgentId) {
        const agent = this.findCapableAgent(task.requiredCapability);
        if (agent) {
          task.assignedAgentId = agent.agentId;
          const state = workflow.taskStates.get(task.id)!;
          state.assignedAgentId = agent.agentId;
        }
      }
    }

    eventBus.emit('orchestration.workflow.started', {
      workflowId: workflow.id,
      name: workflow.name,
    });

    // Execute ready tasks
    await this.executeReadyTasks(workflow);

    return this.serializeWorkflow(workflow);
  }

  /**
   * Get workflow status including task-level progress.
   */
  getWorkflowStatus(workflowId: string): (SerializedWorkflow & { progress: { total: number; completed: number; failed: number; running: number; pending: number; percentComplete: number } }) | null {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return null;

    const states = Array.from(workflow.taskStates.values());
    const total = states.length;
    const completed = states.filter((s) => s.status === 'completed').length;
    const failed = states.filter((s) => s.status === 'failed').length;
    const running = states.filter((s) => s.status === 'running').length;
    const pending = states.filter((s) => s.status === 'pending').length;

    return {
      ...this.serializeWorkflow(workflow),
      progress: {
        total,
        completed,
        failed,
        running,
        pending,
        percentComplete: total > 0 ? Math.round((completed / total) * 100) : 0,
      },
    };
  }

  /**
   * List all workflows, optionally filtered by status.
   */
  listWorkflows(statusFilter?: WorkflowStatus): SerializedWorkflow[] {
    const workflows: SerializedWorkflow[] = [];
    for (const wf of this.workflows.values()) {
      if (!statusFilter || wf.status === statusFilter) {
        workflows.push(this.serializeWorkflow(wf));
      }
    }
    return workflows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Cancel a running or pending workflow.
   */
  cancelWorkflow(workflowId: string): SerializedWorkflow {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      throw new DomainError(ErrorCode.InvalidPayload, 404, `Workflow '${workflowId}' not found.`);
    }

    if (workflow.status !== 'pending' && workflow.status !== 'running') {
      throw new DomainError(
        ErrorCode.InvalidPayload,
        400,
        `Cannot cancel workflow in '${workflow.status}' state.`,
      );
    }

    workflow.status = 'cancelled';

    // Skip any pending/running tasks
    for (const state of workflow.taskStates.values()) {
      if (state.status === 'pending' || state.status === 'running') {
        state.status = 'skipped';
      }
    }

    eventBus.emit('orchestration.workflow.cancelled', {
      workflowId: workflow.id,
    });

    return this.serializeWorkflow(workflow);
  }

  /**
   * Register an agent's capabilities for task assignment.
   */
  registerAgentCapability(agentId: string, capabilities: string[], maxConcurrentTasks: number = 3): AgentCapability {
    const cap: AgentCapability = {
      agentId,
      capabilities,
      maxConcurrentTasks,
      currentTasks: 0,
    };
    this.agentCapabilities.set(agentId, cap);
    return structuredClone(cap);
  }

  /**
   * Get workflow analytics (execution times, bottlenecks, success rates).
   */
  getAnalytics(): WorkflowAnalytics {
    const allWorkflows = Array.from(this.workflows.values());
    const completedWfs = allWorkflows.filter((wf) => wf.status === 'completed');
    const failedWfs = allWorkflows.filter((wf) => wf.status === 'failed');

    const totalDuration = completedWfs.reduce((sum, wf) => sum + (wf.durationMs ?? 0), 0);
    const avgDurationMs = completedWfs.length > 0 ? Math.round(totalDuration / completedWfs.length) : 0;

    const successRate = allWorkflows.length > 0
      ? Math.round((completedWfs.length / allWorkflows.length) * 100)
      : 0;

    // Bottleneck detection: find tasks with highest avg duration or failure rate
    const taskStats = new Map<string, { totalDuration: number; count: number; failures: number }>();
    for (const entry of this.taskExecutionHistory) {
      const stat = taskStats.get(entry.taskName) ?? { totalDuration: 0, count: 0, failures: 0 };
      stat.totalDuration += entry.durationMs;
      stat.count += 1;
      if (!entry.success) stat.failures += 1;
      taskStats.set(entry.taskName, stat);
    }

    const bottlenecks: BottleneckInfo[] = [];
    const taskSuccessRates: Record<string, number> = {};

    for (const [taskName, stat] of taskStats.entries()) {
      const avgDur = Math.round(stat.totalDuration / stat.count);
      const failRate = Math.round((stat.failures / stat.count) * 100);
      taskSuccessRates[taskName] = 100 - failRate;
      bottlenecks.push({
        taskName,
        avgDurationMs: avgDur,
        failureRate: failRate,
        totalExecutions: stat.count,
      });
    }

    // Sort bottlenecks by avg duration desc
    bottlenecks.sort((a, b) => b.avgDurationMs - a.avgDurationMs);

    // Agent performance
    const agentStats = new Map<string, { completed: number; failed: number; totalDuration: number }>();
    for (const entry of this.taskExecutionHistory) {
      if (!entry.agentId) continue;
      const stat = agentStats.get(entry.agentId) ?? { completed: 0, failed: 0, totalDuration: 0 };
      if (entry.success) stat.completed += 1;
      else stat.failed += 1;
      stat.totalDuration += entry.durationMs;
      agentStats.set(entry.agentId, stat);
    }

    const agentPerformance: AgentPerformanceInfo[] = [];
    for (const [agentId, stat] of agentStats.entries()) {
      const total = stat.completed + stat.failed;
      agentPerformance.push({
        agentId,
        tasksCompleted: stat.completed,
        tasksFailed: stat.failed,
        avgDurationMs: total > 0 ? Math.round(stat.totalDuration / total) : 0,
        successRate: total > 0 ? Math.round((stat.completed / total) * 100) : 0,
      });
    }

    return {
      totalWorkflows: allWorkflows.length,
      completedWorkflows: completedWfs.length,
      failedWorkflows: failedWfs.length,
      avgDurationMs,
      successRate,
      bottlenecks: bottlenecks.slice(0, 10),
      taskSuccessRates,
      agentPerformance,
    };
  }

  // ─── Internal helpers ──────────────────────────────────────────────

  private hasCycle(tasks: TaskDefinition[]): boolean {
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const adj = new Map<string, string[]>();

    for (const task of tasks) {
      adj.set(task.id, task.dependsOn);
    }

    const dfs = (nodeId: string): boolean => {
      visited.add(nodeId);
      inStack.add(nodeId);

      for (const dep of adj.get(nodeId) ?? []) {
        if (!visited.has(dep)) {
          if (dfs(dep)) return true;
        } else if (inStack.has(dep)) {
          return true;
        }
      }

      inStack.delete(nodeId);
      return false;
    };

    for (const task of tasks) {
      if (!visited.has(task.id)) {
        if (dfs(task.id)) return true;
      }
    }

    return false;
  }

  private findCapableAgent(capability: string): AgentCapability | null {
    for (const agent of this.agentCapabilities.values()) {
      if (
        agent.capabilities.includes(capability) &&
        agent.currentTasks < agent.maxConcurrentTasks
      ) {
        return agent;
      }
    }
    return null;
  }

  private async executeReadyTasks(workflow: Workflow): Promise<void> {
    const readyTasks = this.getReadyTasks(workflow);

    if (readyTasks.length === 0) {
      // Check if workflow is done
      this.checkWorkflowCompletion(workflow);
      return;
    }

    if (workflow.mode === 'sequential') {
      // Execute one at a time
      for (const task of readyTasks) {
        await this.executeTask(workflow, task);
        // After each task, re-check ready tasks
        const moreReady = this.getReadyTasks(workflow);
        if (moreReady.length === 0) break;
      }
    } else {
      // Parallel: execute all ready tasks concurrently
      await Promise.all(readyTasks.map((task) => this.executeTask(workflow, task)));
    }

    // Recursively execute newly ready tasks
    const moreReady = this.getReadyTasks(workflow);
    if (moreReady.length > 0 && workflow.status === 'running') {
      await this.executeReadyTasks(workflow);
    }

    this.checkWorkflowCompletion(workflow);
  }

  private getReadyTasks(workflow: Workflow): TaskDefinition[] {
    return workflow.tasks.filter((task) => {
      const state = workflow.taskStates.get(task.id)!;
      if (state.status !== 'pending') return false;

      // All dependencies must be completed
      return task.dependsOn.every((depId) => {
        const depState = workflow.taskStates.get(depId)!;
        return depState.status === 'completed';
      });
    });
  }

  private async executeTask(workflow: Workflow, task: TaskDefinition): Promise<void> {
    const state = workflow.taskStates.get(task.id)!;
    const maxAttempts = task.retryPolicy?.maxAttempts ?? 1;
    const baseDelay = task.retryPolicy?.baseDelayMs ?? 100;
    const backoffFactor = task.retryPolicy?.backoffFactor ?? 2;

    state.status = 'running';
    state.startedAt = isoNow();
    state.assignedAgentId = task.assignedAgentId;

    // Increment agent's current tasks
    if (task.assignedAgentId) {
      const agentCap = this.agentCapabilities.get(task.assignedAgentId);
      if (agentCap) agentCap.currentTasks += 1;
    }

    eventBus.emit('orchestration.task.started', {
      workflowId: workflow.id,
      taskId: task.id,
      taskName: task.name,
      agentId: task.assignedAgentId,
    });

    let success = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      state.attempts = attempt;

      try {
        // Simulate task execution (in a real system, this would dispatch to the agent)
        // Task succeeds immediately for now — real implementation would be async
        state.status = 'completed';
        state.completedAt = isoNow();
        state.durationMs = new Date(state.completedAt).getTime() - new Date(state.startedAt!).getTime();
        state.result = { taskId: task.id, executedBy: task.assignedAgentId ?? 'system' };
        success = true;

        this.taskExecutionHistory.push({
          taskName: task.name,
          durationMs: state.durationMs,
          success: true,
          agentId: task.assignedAgentId,
        });

        eventBus.emit('orchestration.task.completed', {
          workflowId: workflow.id,
          taskId: task.id,
          taskName: task.name,
          durationMs: state.durationMs,
          attempts: attempt,
        });

        break;
      } catch (error) {
        if (attempt < maxAttempts) {
          // Exponential backoff delay
          const delay = baseDelay * (backoffFactor ** (attempt - 1));
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          // Final attempt failed
          state.status = 'failed';
          state.failedAt = isoNow();
          state.error = error instanceof Error ? error.message : String(error);
          state.durationMs = new Date(state.failedAt).getTime() - new Date(state.startedAt!).getTime();

          this.taskExecutionHistory.push({
            taskName: task.name,
            durationMs: state.durationMs,
            success: false,
            agentId: task.assignedAgentId,
          });

          eventBus.emit('orchestration.task.failed', {
            workflowId: workflow.id,
            taskId: task.id,
            taskName: task.name,
            error: state.error,
            attempts: attempt,
          });
        }
      }
    }

    // Decrement agent's current tasks
    if (task.assignedAgentId) {
      const agentCap = this.agentCapabilities.get(task.assignedAgentId);
      if (agentCap) agentCap.currentTasks = Math.max(0, agentCap.currentTasks - 1);
    }

    // If task failed, mark dependent tasks as skipped
    if (!success) {
      this.skipDependentTasks(workflow, task.id);
    }
  }

  private skipDependentTasks(workflow: Workflow, failedTaskId: string): void {
    for (const task of workflow.tasks) {
      if (task.dependsOn.includes(failedTaskId)) {
        const state = workflow.taskStates.get(task.id)!;
        if (state.status === 'pending') {
          state.status = 'skipped';
          // Recursively skip tasks depending on skipped tasks
          this.skipDependentTasks(workflow, task.id);
        }
      }
    }
  }

  private checkWorkflowCompletion(workflow: Workflow): void {
    if (workflow.status !== 'running') return;

    const states = Array.from(workflow.taskStates.values());
    const allDone = states.every((s) => s.status === 'completed' || s.status === 'failed' || s.status === 'skipped');

    if (!allDone) return;

    const anyFailed = states.some((s) => s.status === 'failed');

    if (anyFailed) {
      workflow.status = 'failed';
      workflow.failedAt = isoNow();
      workflow.durationMs = new Date(workflow.failedAt).getTime() - new Date(workflow.startedAt!).getTime();

      eventBus.emit('orchestration.workflow.failed', {
        workflowId: workflow.id,
        name: workflow.name,
      });
    } else {
      workflow.status = 'completed';
      workflow.completedAt = isoNow();
      workflow.durationMs = new Date(workflow.completedAt).getTime() - new Date(workflow.startedAt!).getTime();

      eventBus.emit('orchestration.workflow.completed', {
        workflowId: workflow.id,
        name: workflow.name,
        durationMs: workflow.durationMs,
      });
    }
  }

  private serializeWorkflow(workflow: Workflow): SerializedWorkflow {
    const taskStates: Record<string, TaskState> = {};
    for (const [key, value] of workflow.taskStates.entries()) {
      taskStates[key] = structuredClone(value);
    }

    return {
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      status: workflow.status,
      tasks: structuredClone(workflow.tasks),
      taskStates,
      mode: workflow.mode,
      createdAt: workflow.createdAt,
      startedAt: workflow.startedAt,
      completedAt: workflow.completedAt,
      failedAt: workflow.failedAt,
      durationMs: workflow.durationMs,
    };
  }
}
