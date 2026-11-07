import { invoke, isTauri } from '@tauri-apps/api/core';
import { AppError, toAppError } from '../errors/app-error';

const NO_BACKEND: AppError = {
  code: 'backend_unavailable',
  message: 'desktop backend is not available',
};

/** The only place that calls `invoke()`; every rejection becomes an `AppError`. */
export async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw NO_BACKEND;
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    throw toAppError(e);
  }
}
