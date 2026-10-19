# Batch Execution Dependency Validation (#699)

The `batchExecutionDependencyValidator` module provides prerequisite execution dependency validation, cycle detection, and stage scheduling for payroll batch workflows in the ZK Payroll SDK.

## Features

- **Directed Acyclic Graph (DAG) Validation**: Validates batch dependency topologies using Depth-First Search (DFS) to detect circular dependencies and self-referencing loops.
- **Missing Dependency Detection**: Identifies references to non-existent batches within execution pipelines or upstream external stages.
- **Topological Stage Resolution**: Groups batches into parallel execution stages using Kahn's algorithm, allowing independent batches to execute concurrently while ensuring prerequisite ordering.
- **Runtime Status Checking**: Validates whether upstream batches have completed successfully before executing downstream dependent tasks, handling terminal failures or cancellation.
- **Stateful Dependency Validator**: Provides the `BatchExecutionDependencyValidator` class to track runtime status changes, query next executable batches, and advance execution queues dynamically.
- **Structured Error Handling**: Returns actionable error objects with codes (`MISSING_DEPENDENCY`, `CIRCULAR_DEPENDENCY`, `SELF_DEPENDENCY`, `DEPENDENCY_FAILED`, `DEPENDENCY_NOT_MET`) and concrete remediation steps.
