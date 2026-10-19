/**
 * The rendered length against an output's maxDuration (acting stage 5d plan 2). The lint warns
 * from an estimate before synthesis; a render knows the real length (and `--rhythm` may differ
 * from the script), so it warns when the estimate did not.
 */
export function renderedLengthWarning(
  output: string,
  seconds: number,
  maxDuration: number | undefined,
  estimatedOver: boolean,
): string | null {
  if (maxDuration === undefined || seconds <= maxDuration || estimatedOver) return null;
  return `"${output}" is ${seconds.toFixed(1)}s as rendered, over its maxDuration ${maxDuration}s`;
}
