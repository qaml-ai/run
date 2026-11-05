"""Run the original Python SDK suite, replacing only its local server launcher."""
import importlib.util, json, os, pathlib, subprocess, unittest, asyncio
ROOT=pathlib.Path(__file__).resolve().parents[3]
HERE=pathlib.Path(__file__).resolve().parents[1]
os.environ['AGENT_TEST_DATABASE_URL']='postgresql://postgres:local-only-unused@127.0.0.1:55434/camelrun_proto'
spec=importlib.util.spec_from_file_location('upstream_python_sdk',ROOT/'tests/python_sdk.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def database(sql):
    script="import pg from 'pg';const c=new pg.Client(process.env.URL);await c.connect();try{await c.query(process.env.SQL)}finally{await c.end()}"
    subprocess.run(['node','--input-type=module','-e',script],cwd=HERE,check=True,env={**os.environ,'URL':m.DATABASE_URL,'SQL':sql},stdout=subprocess.DEVNULL)
m.database=database
original=asyncio.create_subprocess_exec
async def launch(*args,**kwargs):
    if any(str(x)==str(ROOT/'src/server.ts') for x in args):
        env={**os.environ,**kwargs.get('env',{})}
        kwargs['env']=env
        args=('node','--import',str(HERE/'test/compat-register.mjs'),'--experimental-strip-types','--disable-warning=ExperimentalWarning',str(HERE/'test/python-host.ts'))
    return await original(*args,**kwargs)
asyncio.create_subprocess_exec=launch
class Result(unittest.TextTestResult):
    records=[]
    def addSuccess(self,test): super().addSuccess(test);self.records.append({'test':test.id(),'status':'pass','kind':'worker' if isinstance(test,m.PythonSDKTest) else 'sdk-unit'})
    def addFailure(self,test,err): super().addFailure(test,err);self.records.append({'test':test.id(),'status':'fail','reason':str(err[1])[:500]})
    def addError(self,test,err): super().addError(test,err);self.records.append({'test':test.id(),'status':'fail','reason':str(err[1])[:500]})
    def addSkip(self,test,reason):super().addSkip(test,reason);self.records.append({'test':test.id(),'status':'not-applicable','reason':reason})
# Explicitly excluded transport: voice and audio. Other unsupported core features remain failures.
for name in ('test_voice_sessions_need_the_runtime_to_hold_calls','test_audio_is_transcribed_in_messages_runs_and_on_its_own'):
    setattr(m.PythonSDKTest,name,unittest.skip('Voice/audio excluded by experiment scope')(getattr(m.PythonSDKTest,name)))
suite=unittest.defaultTestLoader.loadTestsFromModule(m)
result=unittest.TextTestRunner(verbosity=1,resultclass=Result).run(suite)
records={record['test']:record for record in result.records}
(HERE/'measurements/python-compat.json').write_text(json.dumps(list(records.values()),indent=2)+'\n')
raise SystemExit(0 if result.wasSuccessful() else 1)
