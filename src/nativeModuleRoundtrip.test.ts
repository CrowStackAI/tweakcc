import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  extractClaudeJsModulesFromNativeInstallation as extract,
  repackNativeInstallationModules as repack,
  type ExtractedBunModule,
} from './nativeInstallation';
import { writeVerbosePropertyModules } from './patches/verboseProperty';

/** Decode a module's source bytes per Bun's string encoding (see index.ts). */
const decode = (module: ExtractedBunModule): string =>
  module.encoding === 2
    ? module.contents.toString('utf16le')
    : module.encoding === 1
      ? module.contents.toString('latin1')
      : module.contents.toString('utf8');

const hasBun = spawnSync('bun', ['--version'], { timeout: 5000 }).status === 0;

// Bun is optional for development and CI. These tests compile only their own
// source into a fresh temp directory; they never discover or alter installed CC.
describe.skipIf(!hasBun)('compiled multi-module native round trip', () => {
  let directory: string;
  let input: string;

  beforeAll(() => {
    directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'tweakcc-native-modules-')
    );
    input = path.join(
      directory,
      process.platform === 'win32' ? 'original.exe' : 'original'
    );
    fs.writeFileSync(
      path.join(directory, 'entry.js'),
      'console.log((await import("./part.js")).value);'
    );
    fs.writeFileSync(
      path.join(directory, 'part.js'),
      'export const value = "original-value";'
    );
    const build = spawnSync(
      'bun',
      [
        'build',
        '--compile',
        '--splitting',
        '--bytecode',
        '--format=esm',
        '--no-compile-autoload-dotenv',
        '--no-compile-autoload-bunfig',
        '--outfile',
        input,
        path.join(directory, 'entry.js'),
      ],
      { encoding: 'utf8', timeout: 30000 }
    );
    expect(build.status, build.stderr).toBe(0);
  }, 40000);

  afterAll(() => {
    // Only this test's exclusively created directory is eligible for cleanup.
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('executes a changed chunk with new bindings, exports, await and Unicode', () => {
    const before = extract(input);
    expect(before).not.toBeNull();
    const target = before!.modules.find(
      module =>
        module.isJavaScript &&
        !module.isEntrypoint &&
        module.contents.includes(Buffer.from('original-value'))
    );
    expect(target).toBeDefined();
    const contents = Buffer.from(
      'const text = await Promise.resolve("🦆 café"); export const value = text; export const extra = 42;'
    );
    const output = path.join(
      directory,
      process.platform === 'win32' ? 'patched.exe' : 'patched'
    );
    repack(
      input,
      {
        sourceSha256: before!.sourceSha256,
        modules: [{ index: target!.index, name: target!.name, contents }],
      },
      output
    );
    const after = extract(output)!;
    expect(after.modules.length).toBe(before!.modules.length);
    for (const module of before!.modules) {
      const actual = after.modules[module.index];
      expect(actual.name).toBe(module.name);
      expect(actual.contents).toEqual(
        module.index === target!.index ? contents : module.contents
      );
    }
    expect(extract(input)!.sourceSha256).toBe(before!.sourceSha256);
    const originalRun = spawnSync(input, [], {
      encoding: 'utf8',
      timeout: 10000,
    });
    const patchedRun = spawnSync(output, [], {
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(originalRun.status, originalRun.stderr).toBe(0);
    expect(originalRun.stdout.trim()).toBe('original-value');
    expect(patchedRun.status, patchedRun.stderr).toBe(0);
    expect(patchedRun.stdout.trim()).toBe('🦆 café');
  }, 30000);

  it('applies a corpus feature patch (verbose) to the chunk that holds it, then round-trips and runs', () => {
    // End-to-end proof of the module-corpus seam on a real compiled multi-module
    // binary: the spinner element lives in a non-entry chunk (as it does in
    // Claude Code), writeVerbosePropertyModules finds it across the corpus, and
    // only that chunk is repacked. The entry stub is never the target.
    const spinner =
      'Q.jsx(HJa,{mode:e,responseLengthRef:o,spinnerSuffix:d,verbose:p,columns:f,thinkingStatus:m,isCompacting:h})';
    fs.writeFileSync(
      path.join(directory, 'ventry.js'),
      'console.log((await import("./vpart.js")).value);'
    );
    fs.writeFileSync(
      path.join(directory, 'vpart.js'),
      `export const value = ${JSON.stringify(spinner)};`
    );
    const vinput = path.join(
      directory,
      process.platform === 'win32' ? 'vorig.exe' : 'vorig'
    );
    const build = spawnSync(
      'bun',
      [
        'build',
        '--compile',
        '--splitting',
        '--bytecode',
        '--format=esm',
        '--no-compile-autoload-dotenv',
        '--no-compile-autoload-bunfig',
        '--outfile',
        vinput,
        path.join(directory, 'ventry.js'),
      ],
      { encoding: 'utf8', timeout: 30000 }
    );
    expect(build.status, build.stderr).toBe(0);

    const before = extract(vinput)!;
    const jsModules = before.modules.filter(m => m.isJavaScript);
    const sources = jsModules.map(decode);
    const patched = writeVerbosePropertyModules(sources);
    expect(patched).not.toBeNull();

    // Exactly one module changed, and it is not the entry stub.
    const changed = jsModules.filter((_, i) => patched![i] !== sources[i]);
    expect(changed).toHaveLength(1);
    expect(changed[0].isEntrypoint).toBe(false);
    expect(patched![jsModules.indexOf(changed[0])]).toContain('verbose:true');

    const output = path.join(
      directory,
      process.platform === 'win32' ? 'vpatched.exe' : 'vpatched'
    );
    repack(
      vinput,
      {
        sourceSha256: before.sourceSha256,
        modules: changed.map(m => ({
          index: m.index,
          name: m.name,
          contents: Buffer.from(patched![jsModules.indexOf(m)], 'utf8'),
        })),
      },
      output
    );

    const originalRun = spawnSync(vinput, [], {
      encoding: 'utf8',
      timeout: 10000,
    });
    const patchedRun = spawnSync(output, [], {
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(originalRun.status, originalRun.stderr).toBe(0);
    expect(originalRun.stdout).toContain('verbose:p');
    expect(patchedRun.status, patchedRun.stderr).toBe(0);
    expect(patchedRun.stdout).toContain('verbose:true');
    expect(patchedRun.stdout).not.toContain('verbose:p');
  }, 40000);

  it.skipIf(process.platform !== 'linux')(
    'uses the verified ELF snapshot if the input changes after the last check',
    () => {
      const mutableInput = path.join(directory, 'concurrently-updated');
      fs.copyFileSync(input, mutableInput);
      const before = extract(mutableInput)!;
      const bytes = fs.readFileSync(mutableInput);
      const output = path.join(directory, 'snapshot-output');
      const read = fs.readFileSync;
      let inputReads = 0;
      // Simulate an updater replacing bytes immediately after the last digest
      // read. A third raw read by the ELF writer would mix two executables.
      const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((
        ...args: Parameters<typeof fs.readFileSync>
      ) => {
        const result = Reflect.apply(read, fs, args);
        if (args[0] === mutableInput && ++inputReads === 2) {
          const changed = Buffer.from(bytes);
          changed[0x100] ^= 0xff;
          fs.writeFileSync(mutableInput, changed);
        }
        return result;
      }) as typeof fs.readFileSync);
      try {
        repack(
          mutableInput,
          { sourceSha256: before.sourceSha256, modules: [] },
          output
        );
        expect(inputReads).toBe(2);
      } finally {
        spy.mockRestore();
      }
      expect(fs.readFileSync(output)[0x100]).toBe(bytes[0x100]);
      expect(fs.readFileSync(mutableInput)[0x100]).not.toBe(bytes[0x100]);
    }
  );

  it('rejects a stale source digest without creating output', () => {
    const output = path.join(directory, 'must-not-exist');
    expect(() =>
      repack(input, { sourceSha256: '0'.repeat(64), modules: [] }, output)
    ).toThrow(/changed since/);
    expect(fs.existsSync(output)).toBe(false);
  });
});
