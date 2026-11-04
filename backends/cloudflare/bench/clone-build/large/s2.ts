import worker, { CloneBuildAgent, CloneBuildDirectory } from '../agent-worker.ts';
import { NativeBenchmarkComputer, type BenchmarkInstance } from '../native.ts';
class Machine extends NativeBenchmarkComputer { protected override instance: BenchmarkInstance = 'standard-2'; }
export { CloneBuildAgent as "camelrun-proto-bench-s2-agent", CloneBuildDirectory as "camelrun-proto-bench-s2-directory", Machine as "camelrun-proto-bench-s2-machine" };
export default worker;
