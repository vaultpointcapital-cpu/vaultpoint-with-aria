"""Aria Pantheon — cheap, deterministic worker agents that watch data and
write structured findings to public.aria_findings. Workers never message
the user directly; only Aria (src/lib/aria/ on the Next.js side) reads
findings and decides what reaches the user and how it's phrased.

v1: argus (loss/risk), plutus (profit), hermes (opportunity scouting),
mnemosyne (periodic reports). nike/themis are reserved names only (see
the aria_findings migration's source_agent check constraint) — no worker
module for either in v1.
"""
