"""Portfolio Risk Aggregator — currency/asset-cluster exposure aggregation
and a book-level monthly drawdown circuit breaker, sitting between
Signal Engine and Decision Gate. See exposure.py, scope.py, gate_check.py,
service.py, and supabase/migrations/20260818000000_add_portfolio_risk_aggregator.sql's
header comment for the full design/scope.
"""
