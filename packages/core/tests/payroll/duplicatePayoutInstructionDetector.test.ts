import {
  PayoutInstruction,
  DuplicatePayoutViolationCode,
  DuplicatePayoutViolation,
  DuplicatePayoutDetectionOptions,
  DuplicatePayoutDetectionResult,
  DuplicatePayoutInstructionError,
  DuplicatePayoutInstructionDetector,
  detectDuplicatePayoutInstructions,
  assertNoDuplicatePayoutInstructions,
  fingerprintPayoutInstruction,
  normalizePayoutAmount,
} from "../../src/payroll/duplicatePayoutInstructionDetector";

describe("Duplicate Payout Instruction Detection (#709)", () => {
  const alice = "GBZXN7PIRZGNMHGA728RGRTDG";
  const bob = "GCLWGQBMKQLZSG5VYLXNV7FRW";

  describe("normalizePayoutAmount", () => {
    it("normalizes integer strings, numbers, and bigints", () => {
      expect(normalizePayoutAmount(100)).toBe("100");
      expect(normalizePayoutAmount("100")).toBe("100");
      expect(normalizePayoutAmount(BigInt(100))).toBe("100");
    });

    it("strips trailing zeroes from decimals", () => {
      expect(normalizePayoutAmount("100.5000")).toBe("100.5");
      expect(normalizePayoutAmount("100.00")).toBe("100");
      expect(normalizePayoutAmount(100.0)).toBe("100");
    });

    it("handles whitespace in amount strings", () => {
      expect(normalizePayoutAmount("  250.75  ")).toBe("250.75");
    });

    it("returns zero for empty or nullish amounts", () => {
      expect(normalizePayoutAmount("")).toBe("0");
    });
  });

  describe("fingerprintPayoutInstruction", () => {
    it("generates stable deterministic fingerprint regardless of key order", () => {
      const inst1: PayoutInstruction = {
        recipient: "GBZXN7PIRZGNMHGA728RGRTDG",
        amount: "100.00",
        asset: "USDC",
        periodId: "2026-10-W1",
      };
      const inst2: PayoutInstruction = {
        asset: "usdc",
        periodId: "2026-10-W1",
        amount: 100,
        recipient: "gbzxn7pirzgnmhga728rgrtdg",
      };

      const fp1 = fingerprintPayoutInstruction(inst1);
      const fp2 = fingerprintPayoutInstruction(inst2);
      expect(fp1).toBe(fp2);
    });

    it("includes periodId in fingerprint when scopeToPeriod is true", () => {
      const inst1: PayoutInstruction = { recipient: alice, amount: 100, periodId: "W1" };
      const inst2: PayoutInstruction = { recipient: alice, amount: 100, periodId: "W2" };

      expect(fingerprintPayoutInstruction(inst1, { scopeToPeriod: true })).not.toBe(
        fingerprintPayoutInstruction(inst2, { scopeToPeriod: true })
      );
    });

    it("omits periodId from fingerprint when scopeToPeriod is false", () => {
      const inst1: PayoutInstruction = { recipient: alice, amount: 100, periodId: "W1" };
      const inst2: PayoutInstruction = { recipient: alice, amount: 100, periodId: "W2" };

      expect(fingerprintPayoutInstruction(inst1, { scopeToPeriod: false })).toBe(
        fingerprintPayoutInstruction(inst2, { scopeToPeriod: false })
      );
    });
  });

  describe("detectDuplicatePayoutInstructions", () => {
    it("returns valid for empty instruction list", () => {
      const result = detectDuplicatePayoutInstructions([]);
      expect(result.isValid).toBe(true);
      expect(result.duplicateCount).toBe(0);
      expect(result.violations).toHaveLength(0);
    });

    it("returns valid when all instructions are unique", () => {
      const instructions: PayoutInstruction[] = [
        { recipient: alice, amount: "100", asset: "USDC" },
        { recipient: bob, amount: "200", asset: "USDC" },
      ];
      const result = detectDuplicatePayoutInstructions(instructions);
      expect(result.isValid).toBe(true);
      expect(result.duplicateCount).toBe(0);
      expect(result.uniqueInstructionCount).toBe(2);
    });

    it("detects exact duplicate payout instructions", () => {
      const instructions: PayoutInstruction[] = [
        { id: "tx-1", recipient: alice, amount: "100", asset: "USDC" },
        { id: "tx-2", recipient: alice, amount: "100", asset: "USDC" },
      ];
      const result = detectDuplicatePayoutInstructions(instructions);
      expect(result.isValid).toBe(false);
      expect(result.duplicateCount).toBe(1);
      expect(result.violations[0].code).toBe("EXACT_DUPLICATE");
      expect(result.violations[0].instructionIndex).toBe(1);
      expect(result.violations[0].matchedInstructionIndex).toBe(0);
      // Privacy check: Redacted message must not leak full recipient or plaintext amount
      expect(result.violations[0].redactedMessage).not.toContain("100");
    });

    it("detects instruction ID collisions", () => {
      const instructions: PayoutInstruction[] = [
        { id: "PAY-001", recipient: alice, amount: "100", asset: "USDC" },
        { id: "PAY-001", recipient: bob, amount: "200", asset: "XLM" },
      ];
      const result = detectDuplicatePayoutInstructions(instructions);
      expect(result.isValid).toBe(false);
      expect(result.violations[0].code).toBe("INSTRUCTION_ID_COLLISION");
      expect(result.violations[0].matchedId).toBe("PAY-001");
    });

    it("detects idempotencyKey collisions", () => {
      const instructions: PayoutInstruction[] = [
        { idempotencyKey: "idem-key-1", recipient: alice, amount: "100" },
        { idempotencyKey: "idem-key-1", recipient: bob, amount: "200" },
      ];
      const result = detectDuplicatePayoutInstructions(instructions);
      expect(result.isValid).toBe(false);
      expect(result.violations[0].code).toBe("IDEMPOTENCY_KEY_COLLISION");
    });

    it("ignores idempotencyKey collisions when checkIdempotencyKeys is false", () => {
      const instructions: PayoutInstruction[] = [
        { idempotencyKey: "idem-key-1", recipient: alice, amount: "100" },
        { idempotencyKey: "idem-key-1", recipient: bob, amount: "200" },
      ];
      const result = detectDuplicatePayoutInstructions(instructions, {
        checkIdempotencyKeys: false,
      });
      expect(result.isValid).toBe(true);
    });

    it("allows recurring payments when allowExplicitRecurring is true", () => {
      const instructions: PayoutInstruction[] = [
        { recipient: alice, amount: "100", asset: "USDC", isRecurring: true },
        { recipient: alice, amount: "100", asset: "USDC", isRecurring: true },
      ];
      const result = detectDuplicatePayoutInstructions(instructions, {
        allowExplicitRecurring: true,
      });
      expect(result.isValid).toBe(true);
      expect(result.duplicateCount).toBe(0);
    });

    it("flags duplicate even if recurring when allowExplicitRecurring is false", () => {
      const instructions: PayoutInstruction[] = [
        { recipient: alice, amount: "100", asset: "USDC", isRecurring: true },
        { recipient: alice, amount: "100", asset: "USDC", isRecurring: true },
      ];
      const result = detectDuplicatePayoutInstructions(instructions, {
        allowExplicitRecurring: false,
      });
      expect(result.isValid).toBe(false);
    });

    it("flags invalid instructions with missing recipient or amount", () => {
      const instructions: PayoutInstruction[] = [
        { recipient: "", amount: "100" },
        { recipient: alice, amount: "" as unknown as number },
      ];
      const result = detectDuplicatePayoutInstructions(instructions);
      expect(result.isValid).toBe(false);
      expect(result.violations.some((v) => v.code === "INVALID_INSTRUCTION")).toBe(true);
    });
  });

  describe("assertNoDuplicatePayoutInstructions", () => {
    it("does not throw when there are no duplicates", () => {
      const instructions: PayoutInstruction[] = [
        { recipient: alice, amount: "100" },
        { recipient: bob, amount: "200" },
      ];
      expect(() => assertNoDuplicatePayoutInstructions(instructions)).not.toThrow();
    });

    it("throws DuplicatePayoutInstructionError when duplicates are detected", () => {
      const instructions: PayoutInstruction[] = [
        { recipient: alice, amount: "100" },
        { recipient: alice, amount: "100" },
      ];
      expect(() => assertNoDuplicatePayoutInstructions(instructions)).toThrow(
        DuplicatePayoutInstructionError
      );
    });
  });

  describe("DuplicatePayoutInstructionDetector (stateful)", () => {
    let detector: DuplicatePayoutInstructionDetector;

    beforeEach(() => {
      detector = new DuplicatePayoutInstructionDetector();
    });

    it("registers unique instructions and detects subsequent duplicates", () => {
      const inst1: PayoutInstruction = { id: "p1", recipient: alice, amount: "100" };
      const inst2: PayoutInstruction = { id: "p2", recipient: alice, amount: "100" };

      const v1 = detector.register(inst1);
      expect(v1).toBeNull();
      expect(detector.size).toBe(1);

      const v2 = detector.register(inst2);
      expect(v2).not.toBeNull();
      expect(v2?.code).toBe("EXACT_DUPLICATE");
    });

    it("checks an instruction without registering it", () => {
      const inst: PayoutInstruction = { recipient: alice, amount: "100" };
      detector.register(inst);

      const checkResult = detector.check(inst);
      expect(checkResult).not.toBeNull();
      expect(detector.size).toBe(1);
    });

    it("clears registered instructions", () => {
      detector.register({ recipient: alice, amount: "100" });
      detector.clear();
      expect(detector.size).toBe(0);

      const checkResult = detector.check({ recipient: alice, amount: "100" });
      expect(checkResult).toBeNull();
    });

    it("returns all registered instructions via getAll", () => {
      detector.register({ id: "1", recipient: alice, amount: "100" });
      detector.register({ id: "2", recipient: bob, amount: "200" });
      expect(detector.getAll()).toHaveLength(2);
    });
  });
});
