import { describe, expect, it, vi } from 'vitest';

import { liftToCorpus } from './index';
import { writeVerbosePropertyModules } from './verboseProperty';
import { writeUserMessageDisplayModules } from './userMessageDisplay';
import type { UserMessageDisplayConfig } from '../types';

// These tests exercise the module-corpus patching seam added for Bun-bytecode
// Claude Code, where a feature's target lives in some chunk rather than the
// ~22 KB entry stub. They use synthetic multi-module source arrays (no Bun
// toolchain needed); the real-binary round trip is covered in
// nativeModuleRoundtrip.test.ts.

describe('liftToCorpus', () => {
  it('edits only the module whose anchor matches, leaving siblings byte-identical', () => {
    const fn = (s: string) =>
      s.includes('NEEDLE') ? s.replace('NEEDLE', 'X') : null;
    const sources = ['const a=1;', 'const b="NEEDLE";', 'const c=3;'];
    const out = liftToCorpus(fn)(sources);
    expect(out).toEqual(['const a=1;', 'const b="X";', 'const c=3;']);
    // The input array is never mutated.
    expect(sources[1]).toBe('const b="NEEDLE";');
  });

  it('returns null (fail-loud) when the anchor is absent from every module', () => {
    const fn = (s: string) =>
      s.includes('NEEDLE') ? s.replace('NEEDLE', 'X') : null;
    expect(liftToCorpus(fn)(['const a=1;', 'const b=2;'])).toBeNull();
  });

  it('reports present-but-unchanged (no null) when a module matched without editing', () => {
    // A patcher that locates its anchor but has nothing to change returns the
    // source unchanged; that must suppress the global null even with no edit.
    const fn = (s: string) => (s.includes('HIT') ? s : null);
    const sources = ['const a=1;', 'const b="HIT";'];
    const out = liftToCorpus(fn)(sources);
    expect(out).toEqual(sources);
    expect(out).not.toBeNull();
  });

  it('suppresses per-module not-found logging from the wrapped patcher', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fn = (s: string) => {
      if (!s.includes('NEEDLE')) {
        console.log('not found');
        console.error('not found');
        return null;
      }
      return s.replace('NEEDLE', 'X');
    };
    try {
      liftToCorpus(fn)(['a', 'NEEDLE', 'b']);
      // The wrapped patcher's own chunk-level chatter is silenced; absence from
      // a given chunk is the expected case across ~1,900 modules.
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('restores console after the sweep', () => {
    const before = console.log;
    liftToCorpus(() => null)(['a']);
    expect(console.log).toBe(before);
  });
});

describe('writeVerbosePropertyModules (trivial patcher, converted)', () => {
  const spinner =
    'Q.jsx(HJa,{mode:e,responseLengthRef:o,spinnerSuffix:d,verbose:p,columns:f,thinkingStatus:m,isCompacting:h})';

  it('forces verbose:true in the chunk that holds the spinner element, not the entry stub', () => {
    const sources = [
      'import "./chunk.js";',
      `const x=${spinner};`,
      'const y=1;',
    ];
    const out = writeVerbosePropertyModules(sources);
    expect(out).not.toBeNull();
    expect(out![0]).toBe(sources[0]); // entry stub untouched
    expect(out![1]).toContain('verbose:true');
    expect(out![1]).not.toContain('verbose:p');
    expect(out![2]).toBe(sources[2]);
  });

  it('returns null when no module contains the spinner element', () => {
    expect(
      writeVerbosePropertyModules(['const a=1;', 'const b=2;'])
    ).toBeNull();
  });
});

const umdConfig: UserMessageDisplayConfig = {
  format: '{}',
  styling: [],
  foregroundColor: 'default',
  backgroundColor: null,
  borderStyle: 'round',
  borderColor: 'rgb(100,100,100)',
  paddingX: 1,
  paddingY: 0,
  fitBoxToContent: false,
};

describe('writeUserMessageDisplayModules (hard patcher, converted)', () => {
  // A single module carrying the display site AND the Text/Box/chalk/React
  // identifiers it injects (Box via displayName, chalk chain, Text destructure).
  const textDef =
    'function Tx({color:A,backgroundColor:B,dimColor:C=!1,bold:D=!1,italic:E=!1}){return null}';
  const boxDef = 'Bx.displayName="Box";';
  const chalk = 'Hc.cyan.bold("a");Hc.green("b");Hc.red.dim("c");';
  const site =
    'function Uc(A){let Z=A.text;if(!Z){return m(Error("No content found in user prompt message")),null}return R.createElement(Bx,{flexDirection:"column"},R.createElement(Sub,{text:Z}))}';
  const coLocated = `${textDef}${boxDef}${chalk}${site}`;

  it('lands the edit in the anchor module when the component vars are co-located', () => {
    const sources = ['import "./c.js";', coLocated, 'const q=1;'];
    const out = writeUserMessageDisplayModules(sources, umdConfig);
    expect(out).not.toBeNull();
    expect(out![0]).toBe(sources[0]);
    expect(out![1]).not.toBe(coLocated);
    expect(out![1]).toContain('Tx'); // injected the resolved Text component
    expect(out![2]).toBe(sources[2]);
  });

  it('returns null (fail-loud) when the display site is present but its component vars are in another chunk', () => {
    // The real Bun-bytecode shape: the "No content found…" site lives in a chunk
    // that imports its Text/Box/chalk/jsx bindings from sibling chunks, so the
    // in-module helpers cannot resolve them. The patcher must refuse rather than
    // inject a dangling identifier — so the corpus result is a loud null.
    const crossModule =
      'function Uc(A){let Z=A.text;if(!Z){return m(Error("No content found in user prompt message")),null}return e(s,{flexDirection:"column",children:e(dC,{text:Z})})}';
    expect(
      writeUserMessageDisplayModules([crossModule, 'const z=1;'], umdConfig)
    ).toBeNull();
  });

  it('returns null when the display site is absent from every module', () => {
    expect(
      writeUserMessageDisplayModules(['const a=1;', 'const b=2;'], umdConfig)
    ).toBeNull();
  });
});
