"""Macro context for the Signal Engine's scoring prompt (news/FOMC
calendar/sentiment, per the PRD's 4B spec). No such data source exists
anywhere in this codebase today — checked news/economic-calendar/
sentiment infrastructure across both the Next.js app and this service;
none exists. Wiring a real vendor (economic calendar API, news sentiment
feed) is separate, unscoped work with no vendor named in the PRD.

Returns {} with a logged note rather than raising or blocking — scoring a
candidate with no macro context is a real (flagged) limitation, not a
reason to skip scoring altogether, same "log and degrade, don't crash the
cycle" treatment every optional data source in this service gets (see
config.py's open_exchange_rates_app_id/resend_api_key handling).
"""

import logging

logger = logging.getLogger("broker_sync")

_WARNED = False


async def build_macro_context() -> dict:
    global _WARNED
    if not _WARNED:
        logger.warning(
            "signal_engine.macro_context: no news/FOMC-calendar/sentiment data source is "
            "configured — scoring will proceed with an empty macro context. Wiring a real "
            "feed is unscoped follow-up work, not attempted here."
        )
        _WARNED = True
    return {}
