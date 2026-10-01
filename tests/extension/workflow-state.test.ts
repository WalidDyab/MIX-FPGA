import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BuildResult, WorkflowStep } from '../../core';
import { applyDetection, initialHardware, resolveProgramTarget, selectBoard } from '../../extension/services/hardware-state';
import { actionCancelled, actionStarted, buildFinished, buildProgressed, checkFinished, initialWorkflow, stagesFromResult } from '../../extension/services/workflow-state';
import { successfulBuild } from './fake-backend';

const states = (s: ReturnType<typeof initialWorkflow>) => [s.stages.synthesis.state, s.stages.implementation.state, s.stages.bitstream.state].join(',');

function failedAt(step: WorkflowStep, implementationStage?: 'synthesis' | 'implementation' | 'bitstream'): BuildResult {
    const order: WorkflowStep[] = ['validate', 'workspace', 'check', 'synthesize', 'constraints', 'implement'];
    const steps = order.slice(0, order.indexOf(step) + 1).map((st) => ({
        step: st,
        status: st === step ? ('failed' as const) : ('succeeded' as const),
        durationMs: 1,
        diagnostics: st === step ? [{ severity: 'error' as const, source: 'implementation' as const, code: 'X', message: `${st} broke` }] : [],
    }));
    return { success: false, steps, diagnostics: [], logs: [], durationMs: 1, ...(implementationStage ? { implementationStage } : {}) };
}

describe('workflow state transitions', () => {
    it('idle -> running -> passed/failed, one action at a time', () => {
        let s = initialWorkflow();
        assert.equal(s.check.state, 'idle');
        s = actionStarted(s, 'check');
        assert.equal(s.running, 'check');
        assert.equal(s.check.state, 'running');
        s = checkFinished(s, { status: 'failed', elaborated: [], logs: [], durationMs: 1, diagnostics: [1, 2].map((i) => ({ severity: 'error' as const, source: 'vhdl' as const, code: 'E', message: `e${i}` })) });
        assert.equal(s.running, undefined);
        assert.deepEqual(s.check, { state: 'failed', summary: '2 errors' });
        s = checkFinished(actionStarted(s, 'check'), { status: 'not-configured', elaborated: [], logs: [], durationMs: 0, diagnostics: [] });
        assert.equal(s.check.state, 'unavailable');
    });

    it('cancelling returns the action to idle', () => {
        const s = actionCancelled(actionStarted(initialWorkflow(), 'build'), 'build');
        assert.equal(s.running, undefined);
        assert.deepEqual(s.build, { state: 'idle', summary: 'Cancelled' });
        assert.equal(s.stages.synthesis.summary, 'Cancelled');
    });
});

describe('build stage transitions', () => {
    it('Synthesis -> Implementation -> Bitstream follow backend progress', () => {
        let s = actionStarted(initialWorkflow(), 'build');
        assert.equal(states(s), 'running,idle,idle');
        s = buildProgressed(s, { kind: 'step-started', step: 'synthesize' });
        s = buildProgressed(s, { kind: 'implementation-stage', stage: 'synthesis' });
        assert.equal(states(s), 'running,idle,idle', 'technology mapping is still synthesis');
        s = buildProgressed(s, { kind: 'implementation-stage', stage: 'implementation' });
        assert.equal(states(s), 'passed,running,idle');
        s = buildProgressed(s, { kind: 'implementation-stage', stage: 'bitstream' });
        assert.equal(states(s), 'passed,passed,running');
        s = buildFinished(s, successfulBuild('hardware.bit'));
        assert.equal(states(s), 'passed,passed,passed');
        assert.equal(s.build.summary, 'BUILD COMPLETE');
    });

    it('a failure marks the stage it happened in and leaves later stages not run', () => {
        assert.deepEqual(Object.values(stagesFromResult(failedAt('check'))).map((x) => x.state), ['failed', 'idle', 'idle']);
        assert.equal(stagesFromResult(failedAt('check')).synthesis.summary, 'check broke');
        assert.deepEqual(Object.values(stagesFromResult(failedAt('constraints'))).map((x) => x.state), ['passed', 'failed', 'idle'], 'pin problems are implementation');
        assert.deepEqual(Object.values(stagesFromResult(failedAt('implement', 'synthesis'))).map((x) => x.state), ['failed', 'idle', 'idle']);
        assert.deepEqual(Object.values(stagesFromResult(failedAt('implement', 'implementation'))).map((x) => x.state), ['passed', 'failed', 'idle']);
        assert.deepEqual(Object.values(stagesFromResult(failedAt('implement', 'bitstream'))).map((x) => x.state), ['passed', 'passed', 'failed']);
    });

    it('failed timing fails Implementation and the build, even with a bitstream', () => {
        const ok = successfulBuild('hardware.bit');
        const r: BuildResult = { ...ok, success: false, timing: { clocks: [{ clock: 'clk', targetMHz: 100, achievedMHz: 80, passed: false }], passed: false } };
        const s = buildFinished(actionStarted(initialWorkflow(), 'build'), r);
        assert.equal(s.stages.implementation.state, 'failed');
        assert.equal(s.stages.implementation.summary, 'Timing FAIL · 80 MHz');
        assert.equal(s.build.summary, 'BUILD FAILED · timing not met');
    });

    it('a step failure reported live marks the running stage failed', () => {
        let s = actionStarted(initialWorkflow(), 'build');
        s = buildProgressed(s, { kind: 'implementation-stage', stage: 'implementation' });
        s = buildProgressed(s, { kind: 'step-finished', step: 'implement', status: 'failed' });
        assert.equal(states(s), 'passed,failed,idle');
    });
});

describe('hardware state', () => {
    const b = (serial: string) => ({ selector: `SN:${serial}`, serialNumber: serial });

    it('keeps a selection only while that board stays connected', () => {
        let s = applyDetection(initialHardware, { configured: true, boards: [b('A'), b('B')], diagnostics: [] });
        assert.deepEqual(resolveProgramTarget(s), { kind: 'choose', boards: [b('A'), b('B')] });
        s = selectBoard(s, 'B');
        assert.deepEqual(resolveProgramTarget(s), { kind: 'selected', serial: 'B' });
        assert.equal(selectBoard(s, 'Z').selectedSerial, 'B', 'unknown serials are ignored');
        s = applyDetection(s, { configured: true, boards: [b('A'), b('C')], diagnostics: [] });
        assert.equal(s.selectedSerial, undefined);
        assert.equal(resolveProgramTarget(s).kind, 'choose');
        s = applyDetection(s, { configured: true, boards: [b('A')], diagnostics: [] });
        assert.deepEqual(resolveProgramTarget(s), { kind: 'single' });
        s = applyDetection(s, { configured: true, boards: [], diagnostics: [] });
        assert.deepEqual(resolveProgramTarget(s), { kind: 'none' });
    });
});
