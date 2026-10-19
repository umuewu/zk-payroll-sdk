/**
 * Batch Execution Dependency Validation (#699)
 *
 * Validates prerequisite execution dependencies, ensures directed acyclic graph (DAG)
 * properties, detects cycles or missing dependencies, and resolves parallel execution
 * stages for multi-batch payroll processing pipelines.
 */

/**
 * Execution status for a payroll batch node.
 */
export type BatchExecutionStatus =
  "pending" | "submitted" | "in_flight" | "completed" | "failed" | "cancelled" | "skipped";

/**
 * Node definition representing a batch in an execution dependency graph.
 */
export interface BatchExecutionNode {
  /** Unique batch identifier */
  batchId: string;
  /** Human-readable label or description */
  name?: string;
  /** List of batch IDs that must complete before this batch can execute */
  dependsOn?: string[];
  /** Expected prerequisite status (defaults to ["completed"]) */
  requiredStatus?: BatchExecutionStatus | BatchExecutionStatus[];
  /** If true, execution continues even if upstream dependency fails or is cancelled */
  allowFailure?: boolean;
  /** Current runtime status of the batch */
  status?: BatchExecutionStatus;
  /** Arbitrary non-sensitive metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Error codes detailing batch dependency failures.
 */
export type DependencyErrorCode =
  | "MISSING_DEPENDENCY"
  | "CIRCULAR_DEPENDENCY"
  | "SELF_DEPENDENCY"
  | "DUPLICATE_BATCH_ID"
  | "INVALID_BATCH_ID"
  | "DEPENDENCY_FAILED"
  | "DEPENDENCY_NOT_MET";

/**
 * Structured validation error for batch dependencies.
 */
export interface DependencyValidationError {
  code: DependencyErrorCode;
  batchId: string;
  dependencyId?: string;
  cycle?: string[];
  message: string;
  suggestedRemediation: string;
}

/**
 * Result of validating batch execution dependencies.
 */
export interface BatchDependencyValidationResult {
  isValid: boolean;
  errors: DependencyValidationError[];
  warnings: string[];
  /** Execution waves/stages where each stage contains batch IDs that can execute concurrently */
  executionStages: string[][];
  /** Flattened topological sequence */
  topologicalOrder: string[];
}

/**
 * Configuration options for batch dependency validation.
 */
export interface DependencyValidationOptions {
  /** If true, an empty batch graph is considered valid. Defaults to true. */
  allowEmptyGraph?: boolean;
  /** If true, checks node `status` against required prerequisite status. Defaults to false. */
  checkRuntimeStatus?: boolean;
  /** Set of known externally completed batch IDs that satisfy upstream dependencies */
  externalCompletedBatchIds?: string[] | Set<string>;
}

/**
 * Typed error thrown when batch execution dependencies fail validation.
 */
export class BatchExecutionDependencyError extends Error {
  public readonly errors: DependencyValidationError[];

  constructor(message: string, errors: DependencyValidationError[]) {
    super(message);
    this.name = "BatchExecutionDependencyError";
    this.errors = errors;
    Object.setPrototypeOf(this, BatchExecutionDependencyError.prototype);
  }
}

/**
 * Validates a collection of batch execution nodes to ensure valid DAG topology,
 * no cycles, no missing dependencies, and optional runtime readiness.
 */
export function validateBatchExecutionDependencies(
  nodes: BatchExecutionNode[],
  options: DependencyValidationOptions = {}
): BatchDependencyValidationResult {
  const errors: DependencyValidationError[] = [];
  const warnings: string[] = [];

  const {
    allowEmptyGraph = true,
    checkRuntimeStatus = false,
    externalCompletedBatchIds = new Set<string>(),
  } = options;

  const externalCompleted =
    externalCompletedBatchIds instanceof Set
      ? externalCompletedBatchIds
      : new Set(externalCompletedBatchIds);

  if (!Array.isArray(nodes) || nodes.length === 0) {
    if (!allowEmptyGraph) {
      errors.push({
        code: "INVALID_BATCH_ID",
        batchId: "root",
        message: "Batch execution graph cannot be empty.",
        suggestedRemediation: "Provide at least one batch execution node.",
      });
    }
    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      executionStages: [],
      topologicalOrder: [],
    };
  }

  // 1. Validate node identity and uniqueness
  const nodeMap = new Map<string, BatchExecutionNode>();
  const seenIds = new Set<string>();

  for (const node of nodes) {
    if (!node || typeof node !== "object") {
      errors.push({
        code: "INVALID_BATCH_ID",
        batchId: "unknown",
        message: "Invalid node entry in batch execution graph.",
        suggestedRemediation: "Ensure all graph items are valid BatchExecutionNode objects.",
      });
      continue;
    }

    const batchId = typeof node.batchId === "string" ? node.batchId.trim() : "";
    if (!batchId) {
      errors.push({
        code: "INVALID_BATCH_ID",
        batchId: "",
        message: "Batch node has missing or empty batchId.",
        suggestedRemediation: "Assign a non-empty string identifier to each batch node.",
      });
      continue;
    }

    if (seenIds.has(batchId)) {
      errors.push({
        code: "DUPLICATE_BATCH_ID",
        batchId,
        message: `Duplicate batch ID detected in execution graph: "${batchId}".`,
        suggestedRemediation: "Ensure every batch node has a unique batchId.",
      });
    } else {
      seenIds.add(batchId);
      nodeMap.set(batchId, { ...node, batchId });
    }
  }

  // 2. Validate dependencies exist and no self-dependencies
  for (const [batchId, node] of nodeMap.entries()) {
    const dependencies = node.dependsOn ?? [];

    for (const dep of dependencies) {
      const depId = typeof dep === "string" ? dep.trim() : "";

      if (!depId) {
        errors.push({
          code: "INVALID_BATCH_ID",
          batchId,
          message: `Batch "${batchId}" contains an empty dependency reference.`,
          suggestedRemediation: "Remove or correct empty strings in dependsOn array.",
        });
        continue;
      }

      if (depId === batchId) {
        errors.push({
          code: "SELF_DEPENDENCY",
          batchId,
          dependencyId: depId,
          message: `Batch "${batchId}" cannot depend on itself.`,
          suggestedRemediation: `Remove "${batchId}" from its own dependsOn array.`,
        });
        continue;
      }

      if (!nodeMap.has(depId) && !externalCompleted.has(depId)) {
        errors.push({
          code: "MISSING_DEPENDENCY",
          batchId,
          dependencyId: depId,
          message: `Batch "${batchId}" depends on non-existent batch "${depId}".`,
          suggestedRemediation: `Add missing batch "${depId}" to execution nodes or ensure it was completed in an external run.`,
        });
      }
    }
  }

  // 3. Cycle detection using Depth-First Search (DFS)
  // State: 0 = unvisited, 1 = visiting (in active recursion stack), 2 = visited
  const visitState = new Map<string, number>();
  const activeStack: string[] = [];
  const cyclesFound = new Set<string>();

  function dfs(currentId: string) {
    visitState.set(currentId, 1);
    activeStack.push(currentId);

    const currentNode = nodeMap.get(currentId);
    if (currentNode && Array.isArray(currentNode.dependsOn)) {
      for (const depId of currentNode.dependsOn) {
        if (!nodeMap.has(depId)) {
          continue; // External or missing (handled in previous step)
        }

        const state = visitState.get(depId) ?? 0;
        if (state === 1) {
          // Cycle detected!
          const cycleStart = activeStack.indexOf(depId);
          const cyclePath = [...activeStack.slice(cycleStart), depId];
          const cycleKey = cyclePath.join(" -> ");

          if (!cyclesFound.has(cycleKey)) {
            cyclesFound.add(cycleKey);
            errors.push({
              code: "CIRCULAR_DEPENDENCY",
              batchId: currentId,
              dependencyId: depId,
              cycle: cyclePath,
              message: `Circular execution dependency detected: ${cycleKey}`,
              suggestedRemediation: `Break the cycle by removing or restructuring one of the dependencies: ${cycleKey}`,
            });
          }
        } else if (state === 0) {
          dfs(depId);
        }
      }
    }

    activeStack.pop();
    visitState.set(currentId, 2);
  }

  for (const batchId of nodeMap.keys()) {
    if ((visitState.get(batchId) ?? 0) === 0) {
      dfs(batchId);
    }
  }

  // 4. Runtime status verification (if requested)
  if (checkRuntimeStatus) {
    for (const [batchId, node] of nodeMap.entries()) {
      const dependencies = node.dependsOn ?? [];

      for (const depId of dependencies) {
        if (externalCompleted.has(depId)) {
          continue;
        }

        const parentNode = nodeMap.get(depId);
        if (!parentNode) {
          continue;
        }

        const parentStatus = parentNode.status ?? "pending";
        const allowedStatuses: BatchExecutionStatus[] = node.requiredStatus
          ? Array.isArray(node.requiredStatus)
            ? node.requiredStatus
            : [node.requiredStatus]
          : ["completed"];

        if (parentStatus === "failed" || parentStatus === "cancelled") {
          if (!node.allowFailure) {
            errors.push({
              code: "DEPENDENCY_FAILED",
              batchId,
              dependencyId: depId,
              message: `Prerequisite batch "${depId}" has terminal failure status "${parentStatus}" required by "${batchId}".`,
              suggestedRemediation: `Resolve failure in upstream batch "${depId}" or set allowFailure: true on batch "${batchId}".`,
            });
          }
        } else if (!allowedStatuses.includes(parentStatus)) {
          errors.push({
            code: "DEPENDENCY_NOT_MET",
            batchId,
            dependencyId: depId,
            message: `Batch "${batchId}" requires prerequisite "${depId}" with status [${allowedStatuses.join(
              ", "
            )}], but found "${parentStatus}".`,
            suggestedRemediation: `Wait for batch "${depId}" to reach one of [${allowedStatuses.join(
              ", "
            )}] before triggering "${batchId}".`,
          });
        }
      }
    }
  }

  // 5. Compute topological stages (Kahn's Algorithm) if no cycle errors
  const executionStages: string[][] = [];
  const topologicalOrder: string[] = [];

  const hasStructuralErrors = errors.some(
    (e) =>
      e.code === "CIRCULAR_DEPENDENCY" ||
      e.code === "MISSING_DEPENDENCY" ||
      e.code === "SELF_DEPENDENCY" ||
      e.code === "DUPLICATE_BATCH_ID"
  );

  if (!hasStructuralErrors && nodeMap.size > 0) {
    // In-degree calculation: how many internal dependencies does node have?
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>(); // parentId -> childIds[]

    for (const batchId of nodeMap.keys()) {
      inDegree.set(batchId, 0);
      dependents.set(batchId, []);
    }

    for (const [batchId, node] of nodeMap.entries()) {
      const deps = (node.dependsOn ?? []).filter(
        (depId) => nodeMap.has(depId) && !externalCompleted.has(depId)
      );
      inDegree.set(batchId, deps.length);

      for (const depId of deps) {
        dependents.get(depId)?.push(batchId);
      }
    }

    // Queue of nodes ready to execute (in-degree == 0)
    let currentStage = Array.from(inDegree.entries())
      .filter(([_, deg]) => deg === 0)
      .map(([id]) => id)
      .sort();

    while (currentStage.length > 0) {
      executionStages.push(currentStage);
      topologicalOrder.push(...currentStage);

      const nextStage: string[] = [];
      for (const parentId of currentStage) {
        const children = dependents.get(parentId) ?? [];
        for (const childId of children) {
          const currentDeg = inDegree.get(childId) ?? 0;
          const newDeg = Math.max(0, currentDeg - 1);
          inDegree.set(childId, newDeg);
          if (newDeg === 0) {
            nextStage.push(childId);
          }
        }
      }

      currentStage = nextStage.sort();
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    executionStages,
    topologicalOrder,
  };
}

/**
 * Asserts that the batch execution dependencies are valid.
 * Throws a `BatchExecutionDependencyError` if any errors are detected.
 */
export function assertBatchExecutionDependencies(
  nodes: BatchExecutionNode[],
  options?: DependencyValidationOptions
): void {
  const result = validateBatchExecutionDependencies(nodes, options);
  if (!result.isValid) {
    const summary = result.errors.map((e) => `[${e.code}] ${e.message}`).join("; ");
    throw new BatchExecutionDependencyError(
      `Batch execution dependency validation failed: ${summary}`,
      result.errors
    );
  }
}

/**
 * Resolves the grouped parallel execution stages for a set of batch nodes.
 * Batches in the same stage can be executed concurrently without dependency conflicts.
 */
export function resolveBatchExecutionStages(
  nodes: BatchExecutionNode[],
  options?: DependencyValidationOptions
): string[][] {
  const result = validateBatchExecutionDependencies(nodes, options);
  if (!result.isValid) {
    const summary = result.errors.map((e) => `[${e.code}] ${e.message}`).join("; ");
    throw new BatchExecutionDependencyError(
      `Cannot resolve execution stages due to dependency errors: ${summary}`,
      result.errors
    );
  }
  return result.executionStages;
}

/**
 * Stateful batch execution manager that tracks node completion status and
 * identifies which batches are unblocked and ready for execution.
 */
export class BatchExecutionDependencyValidator {
  private readonly nodes = new Map<string, BatchExecutionNode>();
  private readonly completedBatches = new Set<string>();

  constructor(initialNodes: BatchExecutionNode[] = []) {
    for (const node of initialNodes) {
      this.addNode(node);
    }
  }

  /**
   * Registers or updates a batch execution node.
   */
  public addNode(node: BatchExecutionNode): void {
    if (!node || !node.batchId) {
      throw new Error("Batch node must have a valid batchId.");
    }
    this.nodes.set(node.batchId, { ...node });
    if (node.status === "completed") {
      this.completedBatches.add(node.batchId);
    }
  }

  /**
   * Updates the runtime status of a given batch.
   */
  public updateStatus(batchId: string, status: BatchExecutionStatus): void {
    const node = this.nodes.get(batchId);
    if (!node) {
      throw new Error(`Batch "${batchId}" not found in validator.`);
    }
    node.status = status;
    if (status === "completed") {
      this.completedBatches.add(batchId);
    } else {
      this.completedBatches.delete(batchId);
    }
  }

  /**
   * Checks whether a specific batch is currently ready to execute.
   */
  public isReadyToExecute(batchId: string): boolean {
    const node = this.nodes.get(batchId);
    if (!node) {
      return false;
    }
    if (node.status === "completed" || node.status === "in_flight") {
      return false;
    }

    const dependencies = node.dependsOn ?? [];
    return dependencies.every((depId) => this.completedBatches.has(depId));
  }

  /**
   * Returns all batch IDs that are currently pending and have all prerequisites satisfied.
   */
  public getExecutableBatches(): string[] {
    const executable: string[] = [];
    for (const [batchId, node] of this.nodes.entries()) {
      if (node.status === "completed" || node.status === "in_flight") {
        continue;
      }
      if (this.isReadyToExecute(batchId)) {
        executable.push(batchId);
      }
    }
    return executable.sort();
  }

  /**
   * Validates the internal graph and returns the full validation result.
   */
  public validate(options?: DependencyValidationOptions): BatchDependencyValidationResult {
    return validateBatchExecutionDependencies(Array.from(this.nodes.values()), {
      ...options,
      externalCompletedBatchIds: this.completedBatches,
    });
  }

  /**
   * Returns parallel execution stages.
   */
  public getStages(): string[][] {
    return resolveBatchExecutionStages(Array.from(this.nodes.values()), {
      externalCompletedBatchIds: this.completedBatches,
    });
  }

  /**
   * Returns the count of registered nodes.
   */
  public get size(): number {
    return this.nodes.size;
  }
}
