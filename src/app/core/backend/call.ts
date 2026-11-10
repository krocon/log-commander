import { invoke, isTauri } from '@tauri-apps/api/core';
import { AppError, toAppError } from '../errors/app-error';
import { withSeq } from './call-order';

const NO_BACKEND: AppError = {
  code: 'backend_unavailable',
  message: 'desktop backend is not available',
};

/**
 * The only place that calls `invoke()`; every rejection becomes an `AppError`. Commands that change state are
 * numbered here, so the backend can tell which of two calls was sent last (`call-order.ts`).
 */
export async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw NO_BACKEND;
  try {
    return await invoke<T>(command, withSeq(command, args));
  } catch (e) {
    throw toAppError(e);
  }
}
