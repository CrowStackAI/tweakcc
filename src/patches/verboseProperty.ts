// Please see the note about writing patches in ./index

import { CorpusPatcher, LocationResult, liftToCorpus, showDiff } from './index';

const getVerbosePropertyLocation = (oldFile: string): LocationResult | null => {
  // CC >=2.1.x compiles the UI with the React JSX automatic runtime, so the
  // spinner element is emitted as `X.jsx(C,{...})` / `X.jsxs(C,{...})` rather
  // than `X.createElement(C,{...})`. Accept all three call forms.
  const createElementPattern =
    /(?:[$\w]+\.)?(?:createElement|jsxs?)\([$\w]+,\{(?=[^}]*responseLengthRef:)(?=[^}]*spinnerSuffix:)(?=[^}]*thinkingStatus:)(?=[^}]*isCompacting:)[^}]*verbose:[^,}]+[^}]*\}/;
  const legacyCreateElementPattern =
    /(?:createElement|jsxs?)\([$\w]+,\{[^}]+spinnerTip[^}]+overrideMessage[^}]+\}/;
  const createElementMatch =
    oldFile.match(createElementPattern) ??
    oldFile.match(legacyCreateElementPattern);

  if (!createElementMatch || createElementMatch.index === undefined) {
    console.error(
      'patch: verbose: failed to find createElement with verbose spinner props'
    );
    return null;
  }

  const extractedString = createElementMatch[0];

  const verbosePattern = /verbose:[^,}]+/;
  const verboseMatch = extractedString.match(verbosePattern);

  if (!verboseMatch || verboseMatch.index === undefined) {
    console.error('patch: verbose: failed to find verbose property');
    return null;
  }

  // Calculate absolute positions in the original file
  const absoluteVerboseStart = createElementMatch.index + verboseMatch.index;
  const absoluteVerboseEnd = absoluteVerboseStart + verboseMatch[0].length;

  return {
    startIndex: absoluteVerboseStart,
    endIndex: absoluteVerboseEnd,
  };
};

export const writeVerboseProperty = (oldFile: string): string | null => {
  const location = getVerbosePropertyLocation(oldFile);
  if (!location) {
    return null;
  }

  const newCode = 'verbose:true';
  const newFile =
    oldFile.slice(0, location.startIndex) +
    newCode +
    oldFile.slice(location.endIndex);

  showDiff(oldFile, newFile, newCode, location.startIndex, location.endIndex);
  return newFile;
};

/**
 * Corpus variant: runs the single-source locator across every native module and
 * forces `verbose:true` wherever the spinner element lives, instead of only the
 * ~22 KB entry stub. Modern Claude Code is a multi-chunk Bun bytecode bundle, so
 * the spinner element is emitted in a chunk, not the entrypoint. Fail-loud: if
 * the anchor is absent from every module the whole patch returns null (see
 * `liftToCorpus`).
 */
// Defer the `liftToCorpus` call to invocation time: this module and ./index
// import each other, so calling it at module-eval time would hit the helper
// before ./index has finished initializing it.
export const writeVerbosePropertyModules: CorpusPatcher = sources =>
  liftToCorpus(writeVerboseProperty)(sources);
