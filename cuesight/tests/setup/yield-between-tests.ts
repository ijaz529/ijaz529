/**
 * Give the worker's event loop a macrotask turn after every test.
 *
 * The vision suites run many synchronous tests back to back (ball-detect-edge and
 * ball-detect-clusters take 3 minutes each). Between them vitest only awaits microtasks, so the
 * worker never handles the main process's RPC replies, and after 60 s vitest reports an unhandled
 * "[vitest-worker]: Timeout calling "onTaskUpdate"" error and exits 1 even though every test
 * passed. One setTimeout(0) per test lets those replies through; it costs nothing measurable.
 */
import { afterEach } from 'vitest';

afterEach(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
