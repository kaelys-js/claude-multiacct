# @foundation/shell

Shell primitives for the foundation toolchain. Wraps `execa` with the four discipline
points every strach-poc/TRP script had to reimplement by hand:

1. **Pipefail equivalent.** Non-zero exit rejects the promise. No swallowed failures.
2. **Stdin closed.** The child cannot block waiting on the operator's terminal.
3. **Enforced timeout.** SIGTERM at the cap, SIGKILL after a grace window.
4. **Structured error.** `ShError` carries command, args, exit code, signal, stdout,
   stderr, timeout flag, and duration for classifiers and structured logs.

## API

```ts
import { sh, ShError, isShError, stdioJournal } from "@foundation/shell";

// Success — resolves with captured stdout/stderr and exit code 0.
const result = await sh("git", ["rev-parse", "--show-toplevel"]);
console.log(result.stdout.trim());

// Failure — throws ShError with the fields a caller needs.
try {
	await sh("false");
} catch (err) {
	if (isShError(err)) {
		console.error(`exit ${err.exitCode}, stderr: ${err.stderr}`);
	}
}

// Journal — stream to stdout/stderr while still capturing.
await sh("pnpm", ["run", "lint"], { journal: stdioJournal({ prefix: "[lint] " }) });

// Timeout — SIGTERM after 5s, SIGKILL 5s later. `timedOut` set on the ShError.
await sh("sleep", ["30"], { timeout: 5000 });
```

## Options

| Option          | Default         | Purpose                                                                         |
| --------------- | --------------- | ------------------------------------------------------------------------------- |
| `cwd`           | `process.cwd()` | Working directory for the child.                                                |
| `env`           | `process.env`   | Extra env merged on top of the parent's; never replaces it.                     |
| `timeout`       | `60000` (60s)   | Kill the child at this cap. `0` disables.                                       |
| `killSignal`    | `"SIGTERM"`     | First signal on timeout.                                                        |
| `killAfterMs`   | `5000`          | SIGKILL grace window after the first signal.                                    |
| `journal`       | `nullJournal()` | Stream child stdout/stderr through these sinks while still capturing.           |
| `rejectOnError` | `true`          | Set `false` for spawnSync-style: never throw, inspect `exitCode` on the result. |

## Result vs error

Both `ShResult` (success) and `ShError` (failure) carry the same shape:
command, args, exit code, signal, stdout, stderr, timedOut, durationMs. A caller
can branch on `isShError` and read the same fields either way.

## Why not just execa?

`execa` is the transport. `@foundation/shell` is the policy: closed stdin,
required timeout, structured error class we control, and a journal contract
symmetric with the fix-task.sh log discipline. Every future product in the
foundation registry consumes it so no script reinvents these four points.
