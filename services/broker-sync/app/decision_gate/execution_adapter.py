"""Execution adapter seam (PRD Sprint 3/4, components 4C/4D) — an
ExecutionAdapter is whatever decision_gate/service.py calls once an
account clears every auto-execution guardrail. NullExecutionAdapter is
the only implementation this phase ships: it logs and does nothing, so
routing/cool-down/audit-logging are all real and fully testable while no
money ever moves. CopyFactoryExecutionAdapter (PRD Sprint 4 — building on
MetaApi's CopyFactory API, a distinct product this repo has never
integrated, needing its own sandbox credentials) implements the same
interface later and swaps in via get_execution_adapter() — service.py
does not change when that happens.
"""

import logging
from abc import ABC, abstractmethod

logger = logging.getLogger("broker_sync")


class ExecutionResult:
    def __init__(self, *, status: str, broker_order_id: str | None = None, detail: str | None = None):
        # status: "executed" | "failed" | "not_wired"
        self.status = status
        self.broker_order_id = broker_order_id
        self.detail = detail


class ExecutionAdapter(ABC):
    @abstractmethod
    async def submit(self, account: dict, candidate: dict, score: dict) -> ExecutionResult:
        raise NotImplementedError


class NullExecutionAdapter(ExecutionAdapter):
    async def submit(self, account: dict, candidate: dict, score: dict) -> ExecutionResult:
        logger.info(
            "decision_gate: auto-execution approved for account_type=%s account_id=%s "
            "candidate=%s but the execution layer (PRD Sprint 4, CopyFactory) is not yet "
            "wired — no trade was placed.",
            account.get("account_type"),
            account.get("id"),
            candidate.get("id"),
        )
        return ExecutionResult(status="not_wired", detail="Execution layer not yet wired (PRD Sprint 4).")


def get_execution_adapter() -> ExecutionAdapter:
    return NullExecutionAdapter()
