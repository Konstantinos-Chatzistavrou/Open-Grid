if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = class TextDecoder {
    decode(buf) {
      if (!buf) return '';
      const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength || buf.length || 0);
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return s;
    }
  };
}
if (typeof globalThis.performance === 'undefined') {
  globalThis.performance = { now: () => Date.now() };
}
if (typeof globalThis.setTimeout === 'undefined') {
  globalThis.setTimeout = (fn) => { if (typeof fn === 'function') fn(); return 0; };
  globalThis.clearTimeout = () => {};
}
async function createRsAudio(moduleArg={}){var Module=moduleArg;var thisProgram="./this.program";var quit_=(status,toThrow)=>{throw toThrow};function locateFile(path){if(Module["locateFile"])return Module["locateFile"](path,"");return""+path}var readAsync,readBinary;if(true){readBinary=f=>{if(globalThis.readbuffer)return new Uint8Array(readbuffer(f));let data=read(f,"binary");assert(typeof data==="object");return data};readAsync=async f=>readBinary(f);globalThis.clearTimeout??=()=>{};globalThis.arguments??globalThis.scriptArgs;if(globalThis.quit)quit_=(status,toThrow)=>{setTimeout(()=>{if(!(toThrow instanceof ExitStatus)){let toLog=toThrow;if(toThrow&&typeof toThrow==="object"&&toThrow.stack)toLog=[toThrow,toThrow.stack];err(`exiting due to exception: ${toLog}`)}quit(status)});throw toThrow};if(globalThis.print){globalThis.console??={};console.log??=print;console.warn??=console.error??=globalThis.printErr??print}}console.log.bind(console);var err=console.error.bind(console);var ABORT=false;var EXITSTATUS;function assert(condition,text){if(!condition)abort(text)}class EmscriptenEH{}class CppException extends EmscriptenEH{constructor(excPtr){super();this.excPtr=excPtr}}function updateMemoryViews(){var b=wasmMemory.buffer;HEAP8=new Int8Array(b);HEAPU8=new Uint8Array(b);HEAPU32=new Uint32Array(b);Module["HEAPF32"]=new Float32Array(b);HEAP64=new BigInt64Array(b)}function preRun(){var preRun=Module["preRun"];if(preRun){if(typeof preRun==="function")preRun=[preRun];onPreRuns.push(...preRun)}callRuntimeCallbacks(onPreRuns)}function initRuntime(){0;wasmExports["B"]()}function postRun(){var postRun=Module["postRun"];if(postRun){if(typeof postRun==="function")postRun=[postRun];onPostRuns.push(...postRun)}callRuntimeCallbacks(onPostRuns)}function abort(what){Module["onAbort"]?.(what);what=`Aborted(${what})`;err(what);ABORT=true;what+=". Build with -sASSERTIONS for more info.";throw new WebAssembly.RuntimeError(what)}var wasmBinaryFile;function findWasmBinary(){return locateFile("rs_audio.wasm")}function getBinarySync(file){if(readBinary)return readBinary(file);throw"both async and sync fetching of the wasm failed"}async function getWasmBinary(binaryFile){if(true)try{return await readAsync(binaryFile)}catch{}return getBinarySync(binaryFile)}async function instantiateArrayBuffer(binaryFile,imports){try{var binary=await getWasmBinary(binaryFile);var instance=await WebAssembly.instantiate(binary,imports);return instance}catch(reason){err(`failed to asynchronously prepare wasm: ${reason}`);abort(reason)}}async function instantiateAsync(binary,binaryFile,imports){if(!binary&&false)try{var response=fetch(binaryFile,{credentials:"same-origin"});var instantiationResult=await WebAssembly.instantiateStreaming(response,imports);return instantiationResult}catch(reason){err(`wasm streaming compile failed: ${reason}`);err("falling back to ArrayBuffer instantiation")}return instantiateArrayBuffer(binaryFile,imports)}function getWasmImports(){var imports={a:wasmImports};return imports}class ExitStatus{name="ExitStatus";constructor(status){this.message=`Program terminated with exit(${status})`;this.status=status}}var callRuntimeCallbacks=callbacks=>{while(callbacks.length>0)callbacks.shift()(Module)};var onPostRuns=[];var onPreRuns=[];var noExitRuntime=true;var stackRestore=val=>__emscripten_stack_restore(val);var stackSave=()=>_emscripten_stack_get_current();var HEAPU8;var UTF8Decoder=globalThis.TextDecoder&&new TextDecoder;var findStringEnd=(heapOrArray,idx,maxBytesToRead,ignoreNul)=>{var maxIdx=idx+maxBytesToRead;if(ignoreNul)return maxIdx;while(heapOrArray[idx]&&!(idx>=maxIdx))++idx;return idx};var UTF8ArrayToString=(heapOrArray,idx=0,maxBytesToRead,ignoreNul)=>{var endPtr=findStringEnd(heapOrArray,idx,maxBytesToRead,ignoreNul);if(endPtr-idx>16&&heapOrArray.buffer&&UTF8Decoder)return UTF8Decoder.decode(heapOrArray.subarray(idx,endPtr));var str="";while(idx<endPtr){var u0=heapOrArray[idx++];if(!(u0&128)){str+=String.fromCharCode(u0);continue}var u1=heapOrArray[idx++]&63;if((u0&224)==192){str+=String.fromCharCode((u0&31)<<6|u1);continue}var u2=heapOrArray[idx++]&63;if((u0&240)==224)u0=(u0&15)<<12|u1<<6|u2;else u0=(u0&7)<<18|u1<<12|u2<<6|heapOrArray[idx++]&63;if(u0<65536)str+=String.fromCharCode(u0);else{var ch=u0-65536;str+=String.fromCharCode(55296|ch>>10,56320|ch&1023)}}return str};var UTF8ToString_cache={};var UTF8ToString=(ptr,maxBytesToRead,ignoreNul)=>{var useCache=maxBytesToRead==null&&ptr>=1024&&ptr<24440;if(useCache){var rtn=UTF8ToString_cache[ptr];if(rtn!=null)return rtn}rtn=ptr?UTF8ArrayToString(HEAPU8,ptr,maxBytesToRead,ignoreNul):"";if(useCache)UTF8ToString_cache[ptr]=rtn;return rtn};var HEAP8;var HEAPU32;class ExceptionInfo{constructor(excPtr){this.excPtr=excPtr;this.ptr=excPtr-24}set_type(type){HEAPU32[this.ptr+4>>2]=type}get_type(){return HEAPU32[this.ptr+4>>2]}set_destructor(destructor){HEAPU32[this.ptr+8>>2]=destructor}get_destructor(){return HEAPU32[this.ptr+8>>2]}set_caught(caught){caught=caught?1:0;HEAP8[this.ptr+12]=caught}get_caught(){return HEAP8[this.ptr+12]!=0}set_rethrown(rethrown){rethrown=rethrown?1:0;HEAP8[this.ptr+13]=rethrown}get_rethrown(){return HEAP8[this.ptr+13]!=0}init(type,destructor){this.set_adjusted_ptr(0);this.set_type(type);this.set_destructor(destructor)}set_adjusted_ptr(adjustedPtr){HEAPU32[this.ptr+16>>2]=adjustedPtr}get_adjusted_ptr(){return HEAPU32[this.ptr+16>>2]}}var exceptionCaught=[];var uncaughtExceptionCount=0;var exceptionLast=null;var setTempRet0=val=>__emscripten_tempret_set(val);var findMatchingCatch=args=>{var thrown=exceptionLast?.excPtr;if(!thrown){setTempRet0(0);return 0}var info=new ExceptionInfo(thrown);info.set_adjusted_ptr(thrown);var thrownType=info.get_type();if(!thrownType){setTempRet0(0);return thrown}for(var caughtType of args){if(!caughtType||caughtType===thrownType)break;var adjusted_ptr_addr=info.ptr+16;if(___cxa_can_catch(caughtType,thrownType,adjusted_ptr_addr)){setTempRet0(caughtType);return thrown}}setTempRet0(thrownType);return thrown};var __Unwind_RaiseException=ex=>{throw ex};var __Unwind_Resume=ex=>{throw ex};var runtimeKeepaliveCounter=0;var handleException=e=>{if(e instanceof ExitStatus||e=="unwind")return EXITSTATUS;quit_(1,e)};var keepRuntimeAlive=()=>noExitRuntime||runtimeKeepaliveCounter>0;var _proc_exit=code=>{EXITSTATUS=code;if(!keepRuntimeAlive()){Module["onExit"]?.(code);ABORT=true}quit_(code,new ExitStatus(code))};var maybeExit=()=>{if(!keepRuntimeAlive())try{_exit(EXITSTATUS)}catch(e){handleException(e)}};var callUserCallback=(func,...args)=>{if(ABORT)return;try{return func(...args)}catch(e){handleException(e)}finally{maybeExit()}};var timers=new Map;var _emscripten_get_now=()=>performance.now();var HEAP64;var bigintToI53Checked=num=>num<-9007199254740992||num>9007199254740992?NaN:Number(num);var checkWasiClock=clock_id=>clock_id>=0&&clock_id<=3;var _emscripten_date_now=()=>Date.now();var abortOnCannotGrowMemory=()=>{abort("OOM")};var ENV={};var getExecutableName=()=>thisProgram;var getEnvStrings=()=>{if(!getEnvStrings.strings){var lang=(globalThis.navigator?.language??"C").replace("-","_")+".UTF-8";var env={USER:"web_user",LOGNAME:"web_user",PATH:"/",PWD:"/",HOME:"/home/web_user",LANG:lang,_:getExecutableName()};for(var x in ENV)if(ENV[x]===void 0)delete env[x];else env[x]=ENV[x];var strings=[];for(var x in env)strings.push(`${x}=${env[x]}`);getEnvStrings.strings=strings}return getEnvStrings.strings};var stringToUTF8Array=(str,heap,outIdx,maxBytesToWrite)=>{if(!(maxBytesToWrite>0))return 0;var startIdx=outIdx;var endIdx=outIdx+maxBytesToWrite-1;for(var i=0;i<str.length;++i){var u=str.codePointAt(i);if(u<=127){if(outIdx>=endIdx)break;heap[outIdx++]=u}else if(u<=2047){if(outIdx+1>=endIdx)break;heap[outIdx++]=192|u>>6;heap[outIdx++]=128|u&63}else if(u<=65535){if(outIdx+2>=endIdx)break;heap[outIdx++]=224|u>>12;heap[outIdx++]=128|u>>6&63;heap[outIdx++]=128|u&63}else{if(outIdx+3>=endIdx)break;heap[outIdx++]=240|u>>18;heap[outIdx++]=128|u>>12&63;heap[outIdx++]=128|u>>6&63;heap[outIdx++]=128|u&63;i++}}heap[outIdx]=0;return outIdx-startIdx};var stringToUTF8=(str,outPtr,maxBytesToWrite)=>stringToUTF8Array(str,HEAPU8,outPtr,maxBytesToWrite);var lengthBytesUTF8=str=>{var len=0;for(var i=0;i<str.length;++i){var u=str.codePointAt(i);if(u<=127)len++;else if(u<=2047)len+=2;else if(u<=65535)len+=3;else{len+=4;i++}}return len};var wasmTableMirror=[];var getWasmTableEntry=funcPtr=>{var func=wasmTableMirror[funcPtr];if(!func)wasmTableMirror[funcPtr]=func=wasmTable.get(funcPtr);return func};var _exit=status=>{EXITSTATUS=status;_proc_exit(status)};if(Module["noExitRuntime"])noExitRuntime=Module["noExitRuntime"];if(Module["print"])Module["print"];if(Module["printErr"])err=Module["printErr"];if(Module["arguments"])Module["arguments"];if(Module["thisProgram"])thisProgram=Module["thisProgram"];var preInit=Module["preInit"];if(preInit){if(typeof preInit==="function")Module["preInit"]=preInit=[preInit];while(preInit.length>0)preInit.shift()()}var __emscripten_timeout,_setThrew,__emscripten_tempret_set,__emscripten_stack_restore,_emscripten_stack_get_current,___cxa_increment_exception_refcount,___cxa_can_catch,___cxa_get_exception_ptr,wasmMemory,wasmTable;function assignWasmExports(wasmExports){Module["_rsa_init"]=wasmExports["C"];Module["_rsa_set_voice"]=wasmExports["D"];Module["_rsa_telemetry_ptr"]=wasmExports["E"];Module["_rsa_out_l_ptr"]=wasmExports["F"];Module["_rsa_out_r_ptr"]=wasmExports["G"];Module["_rsa_apply_telemetry"]=wasmExports["H"];Module["_rsa_trigger_pop"]=wasmExports["I"];Module["_rsa_trigger_flutter"]=wasmExports["J"];Module["_rsa_trigger_crank"]=wasmExports["K"];Module["_rsa_trigger_burble"]=wasmExports["L"];Module["_rsa_trigger_impact"]=wasmExports["M"];Module["_rsa_render"]=wasmExports["N"];__emscripten_timeout=wasmExports["P"];Module["_malloc"]=wasmExports["Q"];Module["_free"]=wasmExports["R"];_setThrew=wasmExports["S"];__emscripten_tempret_set=wasmExports["T"];__emscripten_stack_restore=wasmExports["U"];_emscripten_stack_get_current=wasmExports["V"];___cxa_increment_exception_refcount=wasmExports["W"];___cxa_can_catch=wasmExports["X"];___cxa_get_exception_ptr=wasmExports["Y"];wasmMemory=wasmExports["A"];wasmTable=wasmExports["O"]}var wasmImports={c:(condition,filename,line,func)=>abort(`Assertion failed: ${UTF8ToString(condition)}, at: `+[filename?UTF8ToString(filename):"unknown filename",line,func?UTF8ToString(func):"unknown function"]),z:ptr=>{var info=new ExceptionInfo(ptr);if(!info.get_caught()){info.set_caught(true);uncaughtExceptionCount--}info.set_rethrown(false);exceptionCaught.push(info);return ___cxa_get_exception_ptr(ptr)},e:()=>findMatchingCatch([]),f:arg0=>findMatchingCatch([arg0]),m:(ptr,type,destructor)=>{var info=new ExceptionInfo(ptr);info.init(type,destructor);___cxa_increment_exception_refcount(ptr);ptr=exceptionLast=new CppException(ptr);uncaughtExceptionCount++;__Unwind_RaiseException(ptr)},h:ptr=>{ptr=exceptionLast??=new CppException(ptr);__Unwind_Resume(ptr)},w:()=>abort(""),v:()=>{noExitRuntime=false;runtimeKeepaliveCounter=0},y:(which,timeout_ms)=>{if(timers.has(which)){clearTimeout(timers.get(which));timers.delete(which)}if(!timeout_ms)return 0;var id=setTimeout(()=>{timers.delete(which);callUserCallback(__emscripten_timeout,which,_emscripten_get_now())},timeout_ms);timers.set(which,id);return 0},t:function(clk_id,ignored_precision,ptime){ignored_precision=bigintToI53Checked(ignored_precision);if(!checkWasiClock(clk_id))return 28;var now;if(clk_id===0)now=_emscripten_date_now();else if(1)now=_emscripten_get_now();else return 52;var nsec=Math.round(now*1e6);HEAP64[ptime>>3]=BigInt(nsec);return 0},s:requestedSize=>{HEAPU8.length;requestedSize>>>=0;abortOnCannotGrowMemory()},q:(__environ,environ_buf)=>{var bufSize=0;var envp=0;for(var string of getEnvStrings()){var ptr=environ_buf+bufSize;HEAPU32[__environ+envp>>2]=ptr;bufSize+=stringToUTF8(string,ptr,1/0)+1;envp+=4}return 0},r:(penviron_count,penviron_buf_size)=>{var strings=getEnvStrings();HEAPU32[penviron_count>>2]=strings.length;var bufSize=0;for(var string of strings)bufSize+=lengthBytesUTF8(string)+1;HEAPU32[penviron_buf_size>>2]=bufSize;return 0},p:function(index,a1,a2,a3){var sp=stackSave();try{return getWasmTableEntry(index)(a1,a2,a3)}catch(e){stackRestore(sp);if(!(e instanceof EmscriptenEH))throw e;_setThrew(1,0)}},a:function(index,a1){var sp=stackSave();try{return getWasmTableEntry(index)(a1)}catch(e){stackRestore(sp);if(!(e instanceof EmscriptenEH))throw e;_setThrew(1,0)}},o:function(index,a1,a2){var sp=stackSave();try{return getWasmTableEntry(index)(a1,a2)}catch(e){stackRestore(sp);if(!(e instanceof EmscriptenEH))throw e;_setThrew(1,0)}},j:function(index,a1,a2){var sp=stackSave();try{return getWasmTableEntry(index)(a1,a2)}catch(e){stackRestore(sp);if(!(e instanceof EmscriptenEH))throw e;_setThrew(1,0)}},k:function(index,a1,a2,a3){var sp=stackSave();try{return getWasmTableEntry(index)(a1,a2,a3)}catch(e){stackRestore(sp);if(!(e instanceof EmscriptenEH))throw e;_setThrew(1,0)}},n:function(index){var sp=stackSave();try{getWasmTableEntry(index)()}catch(e){stackRestore(sp);if(!(e instanceof EmscriptenEH))throw e;_setThrew(1,0)}},i:function(index,a1){var sp=stackSave();try{getWasmTableEntry(index)(a1)}catch(e){stackRestore(sp);if(!(e instanceof EmscriptenEH))throw e;_setThrew(1,0)}},x:function(index,a1,a2){var sp=stackSave();try{getWasmTableEntry(index)(a1,a2)}catch(e){stackRestore(sp);if(!(e instanceof EmscriptenEH))throw e;_setThrew(1,0)}},d:function(index,a1,a2,a3){var sp=stackSave();try{getWasmTableEntry(index)(a1,a2,a3)}catch(e){stackRestore(sp);if(!(e instanceof EmscriptenEH))throw e;_setThrew(1,0)}},g:function(index,a1,a2){var sp=stackSave();try{getWasmTableEntry(index)(a1,a2)}catch(e){stackRestore(sp);if(!(e instanceof EmscriptenEH))throw e;_setThrew(1,0)}},l:function(index,a1,a2,a3){var sp=stackSave();try{getWasmTableEntry(index)(a1,a2,a3)}catch(e){stackRestore(sp);if(!(e instanceof EmscriptenEH))throw e;_setThrew(1,0)}},b:function(index,a1,a2,a3,a4){var sp=stackSave();try{getWasmTableEntry(index)(a1,a2,a3,a4)}catch(e){stackRestore(sp);if(!(e instanceof EmscriptenEH))throw e;_setThrew(1,0)}},u:_proc_exit};var wasmExports;wasmExports=await async function(){function receiveInstance(instance){wasmExports=instance.exports;assignWasmExports(wasmExports);updateMemoryViews();return wasmExports}var info=getWasmImports();var instantiateWasm=Module["instantiateWasm"];if(instantiateWasm)return new Promise(resolve=>{instantiateWasm(info,inst=>resolve(receiveInstance(inst)))});wasmBinaryFile??=findWasmBinary();var result=await instantiateAsync(void 0,wasmBinaryFile,info);var exports=function(result){return receiveInstance(result["instance"])}(result);return exports}();await async function(){preRun();var setStatus=Module["setStatus"];if(setStatus){setStatus("Running...");await new Promise(resolve=>setTimeout(resolve,1));setTimeout(setStatus,1,"")}if(ABORT)return;initRuntime();Module["onRuntimeInitialized"]?.();postRun()}();
;return Module}if(typeof exports==="object"&&typeof module==="object"){module.exports=createRsAudio;module.exports.default=createRsAudio}else if(typeof define==="function"&&define["amd"])define([],()=>createRsAudio);
// Apache-2.0 — OpenGrid AudioWorkletProcessor wrapping rs_audio.wasm (appended to Emscripten shell module).
if (typeof AudioWorkletProcessor !== 'undefined' && typeof registerProcessor === 'function') {
  class OpenGridVehicleAudioProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.mod = null;
      this.ready = false;
      this.telPtr = 0;
      this.outLPtr = 0;
      this.outRPtr = 0;
      this.pendingTel = null;
      this.active = false;
      this.port.onmessage = (ev) => {
        const msg = ev.data;
        if (!msg) return;
        if (msg.type === 'init') {
          void this._initWasm(msg);
        } else if (msg.type === 'voice' && this.ready && this.mod) {
          this.mod._rsa_set_voice(msg.voiceId | 0, msg.exhaustStage | 0, msg.turboEnabled ? 1 : 0);
        } else if (msg.type === 'telemetry' && msg.data) {
          this.pendingTel = msg.data;
          this.active = msg.active !== false;
        } else if (msg.type === 'active') {
          this.active = !!msg.active;
        } else if (msg.type === 'trigger' && this.ready && this.mod) {
          if (msg.kind === 'pop') this.mod._rsa_trigger_pop(msg.value ?? 0.85);
          else if (msg.kind === 'flutter') this.mod._rsa_trigger_flutter(msg.value ?? 1.0);
          else if (msg.kind === 'crank') this.mod._rsa_trigger_crank(msg.value ?? 0.42);
          else if (msg.kind === 'burble') this.mod._rsa_trigger_burble(msg.value ?? 0.55);
          else if (msg.kind === 'impact') this.mod._rsa_trigger_impact(msg.value ?? 8.0);
        }
      };
    }

    async _initWasm(msg) {
      try {
        const bytes = new Uint8Array(msg.wasmBinary);
        const m = await createRsAudio({
          instantiateWasm(imports, receiveInstance) {
            WebAssembly.instantiate(bytes, imports).then((res) => receiveInstance(res.instance));
            return {};
          },
        });
        const ok = m._rsa_init(
          msg.voiceId | 0,
          Math.round(sampleRate || 48000),
          msg.simFreq || 4000,
          msg.fluidSubsteps || 3,
          msg.exhaustStage | 0,
          msg.turboEnabled ? 1 : 0,
        );
        if (!ok) {
          this.port.postMessage({ type: 'error', error: 'rsa_init returned 0' });
          return;
        }
        this.mod = m;
        this.telPtr = m._rsa_telemetry_ptr() >> 2;
        this.outLPtr = m._rsa_out_l_ptr() >> 2;
        this.outRPtr = m._rsa_out_r_ptr() >> 2;
        this.ready = true;
        this.port.postMessage({ type: 'ready' });
      } catch (err) {
        this.port.postMessage({ type: 'error', error: String(err) });
      }
    }

    process(_inputs, outputs) {
      const out = outputs[0];
      if (!out || out.length === 0) return true;
      const outL = out[0];
      const outR = out[1] || out[0];
      const n = outL.length;

      if (!this.ready || !this.mod || !this.active) {
        outL.fill(0);
        if (outR !== outL) outR.fill(0);
        return true;
      }

      const heap = this.mod.HEAPF32;
      if (this.pendingTel) {
        heap.set(this.pendingTel, this.telPtr);
        this.pendingTel = null;
        this.mod._rsa_apply_telemetry();
      }
      this.mod._rsa_render(n);
      const h2 = this.mod.HEAPF32;
      const lBase = this.outLPtr;
      const rBase = this.outRPtr;
      for (let i = 0; i < n; i++) {
        outL[i] = h2[lBase + i];
        if (outR !== outL) outR[i] = h2[rBase + i];
      }
      return true;
    }
  }

  registerProcessor('opengrid-vehicle-audio', OpenGridVehicleAudioProcessor);
}
