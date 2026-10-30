/**
 * Lightweight Zero-Dependency 3-Way Line Merge Algorithm (diff3)
 * Takes base, local (our), and remote (their) texts, computes non-conflicting merges
 * and isolates exact conflicting hunks.
 */

export function diff3Merge(baseText = '', ourText = '', theirText = '') {
  const baseLines = baseText.split('\n');
  const ourLines = ourText.split('\n');
  const theirLines = theirText.split('\n');

  // If one side made no changes from base, take the other side
  if (ourText === baseText) {
    return {
      success: true,
      hasConflicts: false,
      mergedText: theirText,
      conflicts: []
    };
  }

  if (theirText === baseText) {
    return {
      success: true,
      hasConflicts: false,
      mergedText: ourText,
      conflicts: []
    };
  }

  if (ourText === theirText) {
    return {
      success: true,
      hasConflicts: false,
      mergedText: ourText,
      conflicts: []
    };
  }

  // Segment-based line merger
  // Compare line modifications relative to base
  const ourDiff = computeLineDiff(baseLines, ourLines);
  const theirDiff = computeLineDiff(baseLines, theirLines);

  const mergedLines = [];
  const conflicts = [];
  let hasConflicts = false;

  let bIdx = 0;
  let oIdx = 0;
  let tIdx = 0;

  // Walk through lines with a block alignment heuristic
  while (bIdx < baseLines.length || oIdx < ourLines.length || tIdx < theirLines.length) {
    const baseLine = bIdx < baseLines.length ? baseLines[bIdx] : undefined;
    const ourLine = oIdx < ourLines.length ? ourLines[oIdx] : undefined;
    const theirLine = tIdx < theirLines.length ? theirLines[tIdx] : undefined;

    // Both identical
    if (ourLine === theirLine) {
      if (ourLine !== undefined) mergedLines.push(ourLine);
      bIdx++;
      oIdx++;
      tIdx++;
      continue;
    }

    // Only 'our' changed relative to base
    if (theirLine === baseLine && ourLine !== baseLine) {
      if (ourLine !== undefined) mergedLines.push(ourLine);
      bIdx++;
      oIdx++;
      tIdx++;
      continue;
    }

    // Only 'their' changed relative to base
    if (ourLine === baseLine && theirLine !== baseLine) {
      if (theirLine !== undefined) mergedLines.push(theirLine);
      bIdx++;
      oIdx++;
      tIdx++;
      continue;
    }

    // Both changed and they differ: Conflict hunk!
    hasConflicts = true;
    const conflictHunk = {
      base: baseLine ?? '',
      our: ourLine ?? '',
      their: theirLine ?? '',
      line: mergedLines.length + 1
    };
    conflicts.push(conflictHunk);

    // Format standard conflict markers into output
    mergedLines.push(`<<<<<<< OUR (Agent A)`);
    if (ourLine !== undefined) mergedLines.push(ourLine);
    mergedLines.push(`======= (Conflict at line ${mergedLines.length})`);
    if (theirLine !== undefined) mergedLines.push(theirLine);
    mergedLines.push(`>>>>>>> THEIR (Agent B)`);

    bIdx++;
    oIdx++;
    tIdx++;
  }

  return {
    success: !hasConflicts,
    hasConflicts,
    mergedText: mergedLines.join('\n'),
    conflicts
  };
}

function computeLineDiff(original, modified) {
  // Simple line status checker
  const diff = [];
  const max = Math.max(original.length, modified.length);
  for (let i = 0; i < max; i++) {
    diff.push({
      orig: original[i],
      mod: modified[i],
      changed: original[i] !== modified[i]
    });
  }
  return diff;
}
