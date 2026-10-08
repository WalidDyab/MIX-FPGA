import type { ToolInvocation, ToolRunner, ToolRunResult } from './tool-runner';

/**
 * Wraps a ToolRunner so everything a tool prints (stdout and stderr) is also handed to `sink`
 * while it runs, whoever started the tool. The wrapped invocation's own `onOutput` still gets
 * its text, and a failing sink can never break a tool run.
 */
export class OutputTeeRunner implements ToolRunner {
    constructor(
        private readonly inner: ToolRunner,
        private readonly sink: (text: string, invocation: ToolInvocation) => void,
    ) {}

    run(invocation: ToolInvocation): Promise<ToolRunResult> {
        const own = invocation.onOutput;
        return this.inner.run({
            ...invocation,
            onOutput: (text) => {
                try {
                    own?.(text);
                } catch {
                    /* an observer must never break the run */
                }
                try {
                    this.sink(text, invocation);
                } catch {
                    /* nor may the console */
                }
            },
        });
    }
}
