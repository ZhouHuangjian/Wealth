"""Pure financial calculations. Public API and policies: see README.md.

Amounts are Decimal/string/integer; floats are rejected. All intermediate work
uses a local 160-digit Decimal context. No function writes ledger facts.
"""

from .calculations import (
    add_months,
    available_cash,
    cashflow_scenario,
    loan_schedule,
    period_profit,
    weighted_average_buy,
    weighted_average_sell,
    xirr,
)

__all__ = [
    "add_months",
    "available_cash",
    "cashflow_scenario",
    "loan_schedule",
    "period_profit",
    "weighted_average_buy",
    "weighted_average_sell",
    "xirr",
]
