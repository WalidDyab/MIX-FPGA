import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { REPO } from '../helpers';

interface Pattern {
    name?: string;
    match?: string;
    begin?: string;
    end?: string;
    patterns?: Pattern[];
    include?: string;
    captures?: Record<string, { name: string }>;
}

const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
const language = pkg.contributes.languages.find((l: { id: string }) => l.id === 'vhdl');
const grammarEntry = pkg.contributes.grammars.find((g: { language: string }) => g.language === 'vhdl');
const grammar = JSON.parse(readFileSync(join(REPO, grammarEntry.path), 'utf8')) as { scopeName: string; patterns: Pattern[]; repository: Record<string, Pattern> };

/** TextMate (Oniguruma) regex -> JS RegExp: the leading (?i) becomes the i flag. */
function js(source: string): RegExp {
    return source.startsWith('(?i)') ? new RegExp(source.slice(4), 'i') : new RegExp(source);
}

function allPatterns(): Pattern[] {
    const out: Pattern[] = [];
    const walk = (p: Pattern) => {
        out.push(p);
        p.patterns?.forEach(walk);
    };
    Object.values(grammar.repository).forEach(walk);
    grammar.patterns.forEach(walk);
    return out;
}

/** Scope a single word/token gets from the first matching top-level rule (good enough for spot checks). */
function scopeOf(text: string): string | undefined {
    for (const inc of grammar.patterns) {
        const group = grammar.repository[inc.include!.slice(1)]!;
        for (const p of group.patterns ?? []) {
            if (!p.match) continue;
            const m = js(p.match).exec(text);
            if (m && m.index === 0 && m[0].length === text.length) return p.name ?? Object.values(p.captures ?? {})[0]?.name;
        }
    }
    return undefined;
}

describe('NexysVHDL VHDL language contribution', () => {
    it('maps .vhd and .vhdl to the vhdl language with a configuration and a grammar', () => {
        assert.deepEqual(language.extensions, ['.vhd', '.vhdl']);
        assert.ok(existsSync(join(REPO, language.configuration)));
        assert.equal(grammarEntry.scopeName, 'source.vhdl');
        assert.equal(grammar.scopeName, 'source.vhdl');
    });

    it('has a valid language configuration: -- comments, brackets, auto-closing, indentation, folding, words', () => {
        const conf = JSON.parse(readFileSync(join(REPO, language.configuration), 'utf8'));
        assert.equal(conf.comments.lineComment, '--');
        assert.deepEqual(conf.brackets, [['(', ')'], ['[', ']']]);
        assert.ok(conf.autoClosingPairs.some((p: { open: string }) => p.open === '('));
        const inc = new RegExp(conf.indentationRules.increaseIndentPattern.pattern, conf.indentationRules.increaseIndentPattern.flags);
        const dec = new RegExp(conf.indentationRules.decreaseIndentPattern.pattern, conf.indentationRules.decreaseIndentPattern.flags);
        for (const line of ['architecture rtl of top is', '    if rising_edge(clk) then', '  begin', 'ENTITY top IS', '  counter : process (clk)', '        when "00" =>']) assert.match(line, inc, line);
        for (const line of ['    end process;', '  elsif x then', '  else', 'END ARCHITECTURE;', '    );']) assert.match(line, dec, line);
        assert.doesNotMatch('    count <= count + 1;', inc);
        const word = new RegExp(conf.wordPattern, 'g');
        assert.deepEqual('count_reg <= 27 + x;'.match(word), ['count_reg', '27', 'x']);
        assert.ok(conf.folding.markers.start);
    });

    it('every grammar regex compiles', () => {
        for (const p of allPatterns()) {
            for (const src of [p.match, p.begin, p.end]) if (src) assert.doesNotThrow(() => js(src), src);
        }
    });

    it('highlights the required teaching vocabulary', () => {
        const expect: Record<string, RegExp> = {
            entity: /keyword\.other/, architecture: /keyword\.other/, configuration: /keyword\.other/, package: /keyword\.other/,
            begin: /keyword\.other/, end: /keyword\.other/, process: /keyword\.other/, component: /keyword\.other/,
            generic: /keyword\.other/, port: /keyword\.other/, map: /keyword\.other/, library: /keyword\.other/, use: /keyword\.other/,
            signal: /storage\.type/, variable: /storage\.type/, constant: /storage\.type/, function: /storage\.type/, procedure: /storage\.type/, type: /storage\.type/, subtype: /storage\.type/,
            if: /keyword\.control/, then: /keyword\.control/, elsif: /keyword\.control/, else: /keyword\.control/, case: /keyword\.control/, when: /keyword\.control/,
            loop: /keyword\.control/, for: /keyword\.control/, while: /keyword\.control/, generate: /keyword\.control/,
            in: /storage\.modifier/, out: /storage\.modifier/, inout: /storage\.modifier/, buffer: /storage\.modifier/,
            std_logic: /support\.type/, std_logic_vector: /support\.type/, signed: /support\.type/, unsigned: /support\.type/,
            integer: /support\.type/, natural: /support\.type/, positive: /support\.type/, boolean: /support\.type/,
            rising_edge: /support\.function/, falling_edge: /support\.function/,
            and: /keyword\.operator/, xor: /keyword\.operator/, '<=': /keyword\.operator/, ':=': /keyword\.operator/, '=>': /keyword\.operator/, '/=': /keyword\.operator/, '+': /keyword\.operator/,
            '42': /constant\.numeric/, '16#FF#': /constant\.numeric/, '1.5e-3': /constant\.numeric/, 'x"F0"': /constant\.numeric/, 'b"0101"': /constant\.numeric/, '8x"FF"': /constant\.numeric/,
            '"text"': /string\.quoted/, "'1'": /constant\.character/, true: /constant\.language/,
            '-- a comment': /comment\.line/,
        };
        for (const [text, scope] of Object.entries(expect)) {
            assert.match(scopeOf(text) ?? '(none)', scope, text);
            if (/^[a-z_]+$/.test(text)) assert.match(scopeOf(text.toUpperCase()) ?? '(none)', scope, `${text} is case-insensitive`);
        }
    });

    it('names declared units and instance labels', () => {
        const entity = grammar.repository['declarations']!.patterns!.find((p) => p.match!.includes('(entity)\\s+([a-z]'))!;
        const m = js(entity.match!).exec('entity blink_counter is')!;
        assert.equal(m[2], 'blink_counter');
        const inst = grammar.repository['declarations']!.patterns!.find((p) => p.captures?.['1']?.name === 'entity.name.label.instance.vhdl')!;
        const i = js(inst.match!).exec('    u_blink : entity work.blink_counter')!;
        assert.deepEqual([i[1], i[4], i[6]], ['u_blink', 'work', 'blink_counter']);
        const ch = grammar.repository['literals']!.patterns!.find((p) => p.name === 'constant.character.vhdl')!;
        assert.equal(js(ch.match!).test("clk'event"), false, "an attribute tick is not a character literal");
    });
});
