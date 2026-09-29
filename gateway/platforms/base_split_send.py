"""Chunk-by-chunk delivery for adapters whose ``send()`` posts one reply as several messages.

``BasePlatformAdapter._send_with_retry`` answers a failed ``send()`` by sending the whole payload
again (transient failures) or its head as plain text (everything else). When the failure was a later
chunk of a split reply, both re-post the chunks that already landed, so the user reads them twice.
:func:`send_split` stops at the failed chunk and, once earlier chunks landed, marks the failure with
the ``partial_overflow`` contract ``_send_with_retry`` reads (it then skips the plain-text fallback)
plus a ``resume`` that sends only the failed chunk onward. The failed chunk is retried exactly as
``_send_with_retry`` would retry it as an unsplit message; the chunks before it never go out twice.
"""

from __future__ import annotations

import functools
from typing import Any, Awaitable, Callable, List, Optional, Sequence

from gateway.platforms.base import SendResult

SendChunk = Callable[[Any, int], Awaitable[SendResult]]
Finish = Callable[[List[SendResult]], Awaitable[SendResult]]


async def send_split(chunks: Sequence[Any], send_chunk: SendChunk, *, finish: Optional[Finish] = None) -> SendResult:
    """Send ``chunks`` in order through ``send_chunk(chunk, index)``, where ``index`` counts the chunks
    already delivered (a resume keeps first-chunk-only reply/quote logic right). Returns
    ``await finish(results)`` once every chunk landed (default: the last chunk's result), else the
    failed chunk's result, marked as a partial delivery when earlier chunks landed."""
    return await _send_from(list(chunks), send_chunk, finish, [])


async def _send_from(
        chunks: List[Any], send_chunk: SendChunk, finish: Optional[Finish], landed: List[SendResult]) -> SendResult:
    for pos, chunk in enumerate(chunks):
        result = await send_chunk(chunk, len(landed))
        if not result.success:
            if landed:
                raw = dict(result.raw_response) if isinstance(result.raw_response, dict) else {}
                raw.update(
                    partial_overflow=True, delivered_chunks=len(landed), total_chunks=len(landed) + len(chunks) - pos,
                    last_message_id=landed[-1].message_id,
                    resume=functools.partial(_send_from, chunks[pos:], send_chunk, finish, list(landed)))
                result.raw_response = raw
            return result
        landed.append(result)
    if finish is not None:
        return await finish(landed)
    return landed[-1] if landed else SendResult(success=True)
