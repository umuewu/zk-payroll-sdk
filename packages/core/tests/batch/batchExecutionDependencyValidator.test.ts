import {
  BatchExecutionNode,
  BatchExecutionStatus,
  BatchExecutionDependencyError,
  BatchExecutionDependencyValidator,
  validateBatchExecutionDependencies,
  assertBatchExecutionDependencies,
  resolveBatchExecutionStages,
} from "../../src/batch/batchExecutionDependencyValidator";

describe("Batch Execution Dependency Validation (#699)", () => {
  describe("validateBatchExecutionDependencies (structural DAG)", () => {
    it("returns valid result for empty node array when allowEmptyGraph is true", () => {
      const result = validateBatchExecutionDependencies([]);
      expect(result.isValid).toBe(true);
      expect(result.executionStages).toHaveLength(0);
      expect(result.topologicalOrder).toHaveLength(0);
    });

    it("returns invalid for empty node array when allowEmptyGraph is false", () => {
      const result = validateBatchExecutionDependencies([], { allowEmptyGraph: false });
      expect(result.isValid).toBe(false);
      expect(result.errors[0].code).toBe("INVALID_BATCH_ID");
    });

    it("validates independent batches with no dependencies and puts them in stage 0", () => {
      const nodes: BatchExecutionNode[] = [
        { batchId: "batch-1", name: "Batch 1" },
        { batchId: "batch-2", name: "Batch 2" },
      ];
      const result = validateBatchExecutionDependencies(nodes);
      expect(result.isValid).toBe(true);
      expect(result.executionStages).toEqual([["batch-1", "batch-2"]]);
      expect(result.topologicalOrder).toEqual(["batch-1", "batch-2"]);
    });

    it("validates sequential batch dependencies (linear pipeline)", () => {
      const nodes: BatchExecutionNode[] = [
        { batchId: "b3", dependsOn: ["b2"] },
        { batchId: "b1" },
        { batchId: "b2", dependsOn: ["b1"] },
      ];
      const result = validateBatchExecutionDependencies(nodes);
      expect(result.isValid).toBe(true);
      expect(result.executionStages).toEqual([["b1"], ["b2"], ["b3"]]);
      expect(result.topologicalOrder).toEqual(["b1", "b2", "b3"]);
    });

    it("validates diamond dependency graph and resolves concurrent stages", () => {
      // b1 -> b2, b3 -> b4
      const nodes: BatchExecutionNode[] = [
        { batchId: "b1" },
        { batchId: "b2", dependsOn: ["b1"] },
        { batchId: "b3", dependsOn: ["b1"] },
        { batchId: "b4", dependsOn: ["b2", "b3"] },
      ];
      const result = validateBatchExecutionDependencies(nodes);
      expect(result.isValid).toBe(true);
      expect(result.executionStages).toEqual([["b1"], ["b2", "b3"], ["b4"]]);
    });

    it("detects self-dependency errors", () => {
      const nodes: BatchExecutionNode[] = [{ batchId: "b1", dependsOn: ["b1"] }];
      const result = validateBatchExecutionDependencies(nodes);
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.code === "SELF_DEPENDENCY")).toBe(true);
    });

    it("detects missing dependency errors", () => {
      const nodes: BatchExecutionNode[] = [{ batchId: "b1", dependsOn: ["non-existent-batch"] }];
      const result = validateBatchExecutionDependencies(nodes);
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.code === "MISSING_DEPENDENCY")).toBe(true);
      expect(result.errors[0].dependencyId).toBe("non-existent-batch");
    });

    it("allows external completed batch IDs to satisfy missing dependencies", () => {
      const nodes: BatchExecutionNode[] = [{ batchId: "b2", dependsOn: ["b1-external"] }];
      const result = validateBatchExecutionDependencies(nodes, {
        externalCompletedBatchIds: ["b1-external"],
      });
      expect(result.isValid).toBe(true);
      expect(result.executionStages).toEqual([["b2"]]);
    });

    it("detects direct 2-node circular dependencies", () => {
      const nodes: BatchExecutionNode[] = [
        { batchId: "b1", dependsOn: ["b2"] },
        { batchId: "b2", dependsOn: ["b1"] },
      ];
      const result = validateBatchExecutionDependencies(nodes);
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.code === "CIRCULAR_DEPENDENCY")).toBe(true);
    });

    it("detects multi-node circular dependencies (3+ nodes)", () => {
      const nodes: BatchExecutionNode[] = [
        { batchId: "b1", dependsOn: ["b3"] },
        { batchId: "b2", dependsOn: ["b1"] },
        { batchId: "b3", dependsOn: ["b2"] },
      ];
      const result = validateBatchExecutionDependencies(nodes);
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.code === "CIRCULAR_DEPENDENCY")).toBe(true);
    });

    it("detects duplicate batch IDs", () => {
      const nodes: BatchExecutionNode[] = [{ batchId: "b1" }, { batchId: "b1" }];
      const result = validateBatchExecutionDependencies(nodes);
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.code === "DUPLICATE_BATCH_ID")).toBe(true);
    });

    it("detects empty or invalid batch IDs", () => {
      const nodes: BatchExecutionNode[] = [{ batchId: "" }, { batchId: "  " }];
      const result = validateBatchExecutionDependencies(nodes);
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.code === "INVALID_BATCH_ID")).toBe(true);
    });
  });

  describe("runtime status validation", () => {
    it("flags DEPENDENCY_NOT_MET when prerequisite is not completed", () => {
      const nodes: BatchExecutionNode[] = [
        { batchId: "b1", status: "in_flight" },
        { batchId: "b2", dependsOn: ["b1"] },
      ];
      const result = validateBatchExecutionDependencies(nodes, { checkRuntimeStatus: true });
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.code === "DEPENDENCY_NOT_MET")).toBe(true);
    });

    it("flags DEPENDENCY_FAILED when prerequisite has failed and allowFailure is false", () => {
      const nodes: BatchExecutionNode[] = [
        { batchId: "b1", status: "failed" },
        { batchId: "b2", dependsOn: ["b1"], allowFailure: false },
      ];
      const result = validateBatchExecutionDependencies(nodes, { checkRuntimeStatus: true });
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.code === "DEPENDENCY_FAILED")).toBe(true);
    });

    it("allows execution when prerequisite failed but allowFailure is true", () => {
      const nodes: BatchExecutionNode[] = [
        { batchId: "b1", status: "failed" },
        { batchId: "b2", dependsOn: ["b1"], allowFailure: true },
      ];
      const result = validateBatchExecutionDependencies(nodes, { checkRuntimeStatus: true });
      expect(result.isValid).toBe(true);
    });

    it("passes when all prerequisites have required status", () => {
      const nodes: BatchExecutionNode[] = [
        { batchId: "b1", status: "completed" },
        { batchId: "b2", dependsOn: ["b1"] },
      ];
      const result = validateBatchExecutionDependencies(nodes, { checkRuntimeStatus: true });
      expect(result.isValid).toBe(true);
    });
  });

  describe("assertBatchExecutionDependencies", () => {
    it("does not throw on valid graph", () => {
      const nodes: BatchExecutionNode[] = [{ batchId: "b1" }, { batchId: "b2", dependsOn: ["b1"] }];
      expect(() => assertBatchExecutionDependencies(nodes)).not.toThrow();
    });

    it("throws BatchExecutionDependencyError on invalid graph", () => {
      const nodes: BatchExecutionNode[] = [
        { batchId: "b1", dependsOn: ["b2"] },
        { batchId: "b2", dependsOn: ["b1"] },
      ];
      expect(() => assertBatchExecutionDependencies(nodes)).toThrow(BatchExecutionDependencyError);
    });
  });

  describe("resolveBatchExecutionStages", () => {
    it("returns correct stages for complex pipeline", () => {
      const nodes: BatchExecutionNode[] = [
        { batchId: "init" },
        { batchId: "payout-usdc", dependsOn: ["init"] },
        { batchId: "payout-xlm", dependsOn: ["init"] },
        { batchId: "summary", dependsOn: ["payout-usdc", "payout-xlm"] },
        { batchId: "audit", dependsOn: ["summary"] },
      ];
      const stages = resolveBatchExecutionStages(nodes);
      expect(stages).toEqual([["init"], ["payout-usdc", "payout-xlm"], ["summary"], ["audit"]]);
    });

    it("throws when resolving stages on cyclic graph", () => {
      const nodes: BatchExecutionNode[] = [
        { batchId: "a", dependsOn: ["b"] },
        { batchId: "b", dependsOn: ["a"] },
      ];
      expect(() => resolveBatchExecutionStages(nodes)).toThrow(BatchExecutionDependencyError);
    });
  });

  describe("BatchExecutionDependencyValidator (stateful)", () => {
    let validator: BatchExecutionDependencyValidator;

    beforeEach(() => {
      validator = new BatchExecutionDependencyValidator([
        { batchId: "b1", status: "pending" },
        { batchId: "b2", dependsOn: ["b1"], status: "pending" },
        { batchId: "b3", dependsOn: ["b2"], status: "pending" },
      ]);
    });

    it("correctly identifies initially executable batches", () => {
      expect(validator.isReadyToExecute("b1")).toBe(true);
      expect(validator.isReadyToExecute("b2")).toBe(false);
      expect(validator.getExecutableBatches()).toEqual(["b1"]);
    });

    it("advances executable batches when status is updated to completed", () => {
      validator.updateStatus("b1", "completed");
      expect(validator.isReadyToExecute("b1")).toBe(false); // already completed
      expect(validator.isReadyToExecute("b2")).toBe(true);
      expect(validator.getExecutableBatches()).toEqual(["b2"]);

      validator.updateStatus("b2", "completed");
      expect(validator.isReadyToExecute("b3")).toBe(true);
      expect(validator.getExecutableBatches()).toEqual(["b3"]);
    });

    it("tracks node count and dynamic node additions", () => {
      expect(validator.size).toBe(3);
      validator.addNode({ batchId: "b4", dependsOn: ["b1"] });
      expect(validator.size).toBe(4);

      validator.updateStatus("b1", "completed");
      expect(validator.getExecutableBatches()).toEqual(["b2", "b4"]);
    });

    it("validates internal state and returns stages", () => {
      const validation = validator.validate();
      expect(validation.isValid).toBe(true);
      const stages = validator.getStages();
      expect(stages).toHaveLength(3);
    });
  });
});
