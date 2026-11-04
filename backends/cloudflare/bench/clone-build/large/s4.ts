import worker, { CloneBuildAgent, CloneBuildDirectory } from '../agent-worker.ts';
import { NativeBenchmarkComputer, type BenchmarkInstance } from '../native.ts';
class Machine extends NativeBenchmarkComputer { protected override instance: BenchmarkInstance = 'standard-4'; }
export { CloneBuildAgent as "camelrun-proto-bench-s4-agent", CloneBuildDirectory as "camelrun-proto-bench-s4-directory", Machine as "camelrun-proto-bench-s4-machine" };
export default worker;
