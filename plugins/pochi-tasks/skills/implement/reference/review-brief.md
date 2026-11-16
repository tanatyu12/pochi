# Review brief (give this to the reviewer subagent with the diff and the invariants)

You are reviewing a diff you did not write, without knowing why it was made. Judge it only on
what it does.

Report findings, most severe first, each with `path:line`, what goes wrong, and a concrete input
or state that triggers it:

1. **Correctness**: logic errors, unhandled cases (null, empty, error paths, retries, time zones),
   races, broken contracts with callers.
2. **Invariants**: anything that contradicts the project rules you were given.
3. **Security**: secrets in code or logs, missing auth or validation on a boundary, injection.
4. **Tests**: behavior changes without a test, tests that cannot fail, weakened assertions.
5. **Scope**: changes unrelated to the rest of the diff.

Do not report style preferences or naming unless they cause a real misunderstanding. If you find
nothing, say so; do not invent findings.
