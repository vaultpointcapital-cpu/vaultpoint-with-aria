import { NextResponse } from 'next/server';

/**
 * Every API route returns this shape on error — per dev rule #6.
 * Never leak raw stack traces or internal error messages to the client;
 * log the real error server-side and return a safe, generic `details`.
 */
export interface ApiErrorBody {
  error: string;
  code: string;
  details?: unknown;
}

export type ApiErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'TIER_LIMIT_REACHED'
  | 'BROKER_SYNC_ERROR'
  | 'PAYMENT_ERROR'
  | 'INTERNAL_ERROR'
  | 'RATE_LIMITED'
  | 'KYC_REQUIRED'
  | 'LIMIT_EXCEEDED';

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 422,
  TIER_LIMIT_REACHED: 402,
  BROKER_SYNC_ERROR: 502,
  PAYMENT_ERROR: 502,
  INTERNAL_ERROR: 500,
  RATE_LIMITED: 429,
  KYC_REQUIRED: 403,
  LIMIT_EXCEEDED: 422,
};

export function apiError(
  code: ApiErrorCode,
  message: string,
  details?: unknown
): NextResponse<ApiErrorBody> {
  return NextResponse.json({ error: message, code, details }, { status: STATUS_BY_CODE[code] });
}

export function apiSuccess<T>(data: T, status = 200): NextResponse<T> {
  return NextResponse.json(data, { status });
}
