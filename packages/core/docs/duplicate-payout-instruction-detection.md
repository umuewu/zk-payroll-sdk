# Duplicate Payout Instruction Detection (#709)

The `duplicatePayoutInstructionDetector` module provides pre-flight duplicate payment detection for payroll operations in the ZK Payroll SDK.

## Features

- **Semantic Fingerprinting**: Deterministically hashes recipient addresses, amounts, assets, memos, and optional period IDs.
- **Normalization Engine**: Normalizes address case, trims whitespace, and canonicalizes numeric base-unit and decimal formats.
- **Batch & Stream Validation**: Detects duplicates both within an in-memory batch (`detectDuplicatePayoutInstructions`) and over time across continuous runs (`DuplicatePayoutInstructionDetector`).
- **Recurring Payments Support**: Allows intentionally recurring disbursements when flagged with `isRecurring: true` or `metadata.recurring: true`.
- **Privacy Guarantees**: Masks employee addresses and hides plaintext salary figures in error messages and logs.
- **Actionable Violations**: Provides structured error codes (`EXACT_DUPLICATE`, `IDEMPOTENCY_KEY_COLLISION`, `INSTRUCTION_ID_COLLISION`) and suggested remediation actions.
